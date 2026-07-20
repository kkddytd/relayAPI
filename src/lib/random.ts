let fallbackSequence = 0;

export function createRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(0, Math.trunc(length)));
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    try {
      cryptoApi.getRandomValues(bytes);
      return bytes;
    } catch {
      // Continue with a correlation-ID fallback in restricted webviews.
    }
  }

  // These fallback values are correlation IDs only. Authentication and stored
  // credential encryption remain on the server and always use Node crypto.
  fallbackSequence = (fallbackSequence + 1) >>> 0;
  let state = (Date.now() ^ fallbackSequence ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = (state ^ Math.floor(Math.random() * 256)) & 0xff;
  }
  return bytes;
}

export function createUuid(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    try {
      return cryptoApi.randomUUID();
    } catch {
      // Some webviews expose the method but reject it outside a secure origin.
    }
  }

  const bytes = createRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
