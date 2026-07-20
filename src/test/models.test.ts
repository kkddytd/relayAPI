import { describe, expect, it } from "vitest";
import { modelIdsShareProfile, resolveModelProfile, resolveModelProfileId } from "@/lib/models";

describe("model profile aliases", () => {
  it("maps supported Fable aliases to the canonical profile", () => {
    for (const alias of ["claude-5-fable", "fable5", "fable-5", "claude-fable-5-20260715", "claude-fable-5[fast]"]) {
      expect(resolveModelProfileId(alias), alias).toBe("claude-fable-5");
    }
    expect(resolveModelProfile("claude-5-fable").match).toBe("alias");
    expect(modelIdsShareProfile("claude-5-fable", "claude-fable-5")).toBe(true);
  });

  it("recognizes controlled Claude and GPT snapshots without collapsing variants", () => {
    expect(resolveModelProfileId("claude-4-8-opus-fast")).toBe("claude-opus-4-8");
    expect(resolveModelProfileId("gpt-5.5-chat-latest")).toBe("gpt-5.5");
    expect(resolveModelProfileId("gpt-5.6-sol-20260715")).toBe("gpt-5.6-sol");
    expect(resolveModelProfileId("gpt-5.6-sol")).not.toBe("gpt-5.6");
  });

  it("keeps vendor namespaces and unknown suffixes outside built-in profiles", () => {
    expect(resolveModelProfileId("vendor/claude-fable-5")).toBeNull();
    expect(resolveModelProfileId("claude-fable-5-evil")).toBeNull();
    expect(resolveModelProfileId("vendor-private-fable")).toBeNull();
  });
});
