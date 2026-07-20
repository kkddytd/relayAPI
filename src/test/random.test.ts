import { afterEach, describe, expect, it, vi } from "vitest";
import { createRandomBytes, createUuid } from "@/lib/random";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser-safe random identifiers", () => {
  it("uses native randomUUID when the secure-context API is available", () => {
    const randomUUID = vi.fn(() => "12345678-1234-4234-9234-123456789abc");
    vi.stubGlobal("crypto", { randomUUID, getRandomValues: vi.fn() });

    expect(createUuid()).toBe("12345678-1234-4234-9234-123456789abc");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("builds a UUID v4 with getRandomValues when randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (target: Uint8Array) => {
        target.forEach((_, index) => { target[index] = index; });
        return target;
      },
    });

    const value = createUuid();
    expect(value).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(value).toBe("00010203-0405-4607-8809-0a0b0c0d0e0f");
    expect(createRandomBytes(4)).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it("falls back when a restricted webview exposes randomUUID but throws", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => { throw new DOMException("Not allowed", "SecurityError"); },
      getRandomValues: (target: Uint8Array) => {
        target.fill(7);
        return target;
      },
    });

    expect(createUuid()).toBe("07070707-0707-4707-8707-070707070707");
  });

  it("still returns distinct correlation IDs when Web Crypto is absent", () => {
    vi.stubGlobal("crypto", undefined);
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const first = createUuid();
    const second = createUuid();
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
    expect(second).not.toBe(first);
  });
});
