import { describe, expect, it } from "vitest";

import { validateExtractDataRequest } from "../../seller-api/src/adapters/extract-data/validate";

describe("extract data request validation", () => {
  it("rejects missing text and fields", () => {
    const result = validateExtractDataRequest({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("text");
      expect(result.missing).toContain("fields");
    }
  });

  it("rejects text above 5000 characters", () => {
    const result = validateExtractDataRequest({
      text: "a".repeat(5001),
      fields: ["email"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("text must be at most 5000 characters");
    }
  });

  it("rejects invalid field entries", () => {
    const result = validateExtractDataRequest({
      text: "hello",
      fields: ["email", ""],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain(
        "fields entries must be non-empty strings up to 80 characters",
      );
    }
  });

  it("accepts valid text and unique trimmed fields", () => {
    const result = validateExtractDataRequest({
      text: "  Contact alice@example.com  ",
      fields: [" email ", "email", "name"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        text: "Contact alice@example.com",
        fields: ["email", "name"],
      });
    }
  });
});
