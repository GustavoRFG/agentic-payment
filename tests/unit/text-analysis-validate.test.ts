import { describe, expect, it } from "vitest";

import { validateTextAnalysisRequest } from "../../seller-api/src/adapters/text-analysis/validate";

describe("text analysis request validation", () => {
  it("rejects empty text", () => {
    const result = validateTextAnalysisRequest({ text: "" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain("text");
  });

  it("rejects text above 2000 characters", () => {
    const result = validateTextAnalysisRequest({ text: "a".repeat(2001) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("text must be at most 2000 characters");
    }
  });

  it("rejects invalid mode", () => {
    const result = validateTextAnalysisRequest({ text: "hello", mode: "tone" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain(
        "mode must be one of: summary, sentiment, entities, full",
      );
    }
  });

  it("defaults valid text without mode to full", () => {
    const result = validateTextAnalysisRequest({ text: "  Hello world.  " });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ text: "Hello world.", mode: "full" });
    }
  });

  it("accepts valid text with summary mode", () => {
    const result = validateTextAnalysisRequest({
      text: "A short paragraph.",
      mode: "summary",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        text: "A short paragraph.",
        mode: "summary",
      });
    }
  });
});
