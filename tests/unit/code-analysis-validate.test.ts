import { describe, expect, it } from "vitest";

import { validateCodeAnalysisRequest } from "../../seller-api/src/adapters/code-analysis/validate";

describe("code analysis request validation", () => {
  it("rejects missing code", () => {
    const result = validateCodeAnalysisRequest({ language: "typescript" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain("code");
  });

  it("rejects code above 5000 characters", () => {
    const result = validateCodeAnalysisRequest({ code: "a".repeat(5001) });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("code must be at most 5000 characters");
    }
  });

  it("rejects non-string language", () => {
    const result = validateCodeAnalysisRequest({ code: "return 1;", language: 1 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toContain("language must be a string");
    }
  });

  it("accepts valid code and trims input", () => {
    const result = validateCodeAnalysisRequest({
      code: "  const x = 1;  ",
      language: " typescript ",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        code: "const x = 1;",
        language: "typescript",
      });
    }
  });
});
