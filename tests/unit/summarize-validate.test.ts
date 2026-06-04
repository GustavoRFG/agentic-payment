import { describe, expect, it } from "vitest";

import { validateSummarizeRequest } from "../../seller-api/src/adapters/summarize/validate";

describe("summarize request validation", () => {
  it("rejects empty text", () => {
    const result = validateSummarizeRequest({ text: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain("text");
  });

  it("rejects text above 10000 characters", () => {
    const result = validateSummarizeRequest({ text: "a".repeat(10001) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("text must be at most 10000 characters");
    }
  });

  it("rejects invalid maxPoints", () => {
    const result = validateSummarizeRequest({ text: "hello", maxPoints: 21 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("maxPoints must be an integer from 1 to 20");
    }
  });

  it("defaults maxPoints to 5", () => {
    const result = validateSummarizeRequest({ text: "  Hello world.  " });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ text: "Hello world.", maxPoints: 5 });
    }
  });
});
