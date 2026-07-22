function abortError(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("operation_aborted");
  error.name = "AbortError";
  return error;
}

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function delayUntil(timestamp, signal) {
  const delay = Math.max(0, timestamp - Date.now());
  if (delay === 0) return Promise.resolve();
  return waitFor(new Promise((resolve) => setTimeout(resolve, delay)), signal);
}

export function createKeyedSerialQueue() {
  const tails = new Map();
  const cooldowns = new Map();

  return {
    get size() {
      return tails.size;
    },
    defer(key, delayMs) {
      const delay = Number.isFinite(delayMs) ? Math.max(0, Math.trunc(delayMs)) : 0;
      if (!key || delay === 0) return;
      cooldowns.set(key, Math.max(cooldowns.get(key) ?? 0, Date.now() + delay));
    },
    async acquire(key, signal) {
      const queueKey = String(key ?? "");
      const previous = tails.get(queueKey) ?? Promise.resolve();
      let releaseTail;
      const current = new Promise((resolve) => {
        releaseTail = resolve;
      });
      tails.set(queueKey, current);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseTail();
        if (tails.get(queueKey) === current) {
          tails.delete(queueKey);
          if ((cooldowns.get(queueKey) ?? 0) <= Date.now()) cooldowns.delete(queueKey);
        }
      };
      try {
        await waitFor(previous, signal);
        await delayUntil(cooldowns.get(queueKey) ?? 0, signal);
      } catch (error) {
        previous.then(release);
        throw error;
      }
      return release;
    },
    async run(key, signal, task) {
      const release = await this.acquire(key, signal);
      try {
        return await task();
      } finally {
        release();
      }
    },
  };
}
