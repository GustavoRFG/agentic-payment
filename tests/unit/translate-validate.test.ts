import { describe, expect, it } from "vitest";

import { validateTranslateRequest } from "../../seller-api/src/adapters/translate/validate";

describe("translate request validation", () => {
  it("rejects missing text and target language", () => {
    const result = validateTranslateRequest({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("text");
      expect(result.missing).toContain("targetLanguage");
    }
  });

  it("rejects text above 5000 characters", () => {
    const result = validateTranslateRequest({
      text: "a".repeat(5001),
      targetLanguage: "English",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("text must be at most 5000 characters");
    }
  });

  it("rejects target language above 80 characters", () => {
    const result = validateTranslateRequest({
      text: "hola",
      targetLanguage: "a".repeat(81),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain(
        "targetLanguage must be at most 80 characters",
      );
    }
  });

  it("accepts valid text and target language", () => {
    const result = validateTranslateRequest({
      text: "  hola  ",
      targetLanguage: " English ",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        text: "hola",
        targetLanguage: "English",
      });
    }
  });
});
