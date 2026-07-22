import { describe, expect, it, vi } from "vitest";
import { createKeyedSerialQueue } from "./keyed-serial-queue.mjs";

describe("keyed serial queue", () => {
  it("serializes the same key while allowing different keys to run", async () => {
    const queue = createKeyedSerialQueue();
    const events = [];
    let releaseFirst;
    const blocker = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run("same", undefined, async () => {
      events.push("first:start");
      await blocker;
      events.push("first:end");
    });
    const second = queue.run("same", undefined, async () => {
      events.push("second:start");
    });
    const other = queue.run("other", undefined, async () => {
      events.push("other:start");
    });
    await other;
    expect(events).toEqual(["first:start", "other:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(["first:start", "other:start", "first:end", "second:start"]);
  });

  it("applies a per-key cooldown and supports cancellation", async () => {
    vi.useFakeTimers();
    try {
      const queue = createKeyedSerialQueue();
      queue.defer("limited", 5_000);
      let started = false;
      const pending = queue.run("limited", undefined, async () => {
        started = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(started).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await pending;
      expect(started).toBe(true);

      queue.defer("cancelled", 5_000);
      const controller = new AbortController();
      const cancelled = queue.run("cancelled", controller.signal, async () => undefined);
      controller.abort(new DOMException("cancelled", "AbortError"));
      await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps later waiters behind an active task when a middle waiter cancels", async () => {
    const queue = createKeyedSerialQueue();
    const events = [];
    let releaseFirst;
    const blocker = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run("same", undefined, async () => {
      events.push("first:start");
      await blocker;
      events.push("first:end");
    });
    const controller = new AbortController();
    const second = queue.run("same", controller.signal, async () => {
      events.push("second:start");
    });
    const third = queue.run("same", undefined, async () => {
      events.push("third:start");
    });

    controller.abort(new DOMException("cancelled", "AbortError"));
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, third]);
    expect(events).toEqual(["first:start", "first:end", "third:start"]);
  });
});
