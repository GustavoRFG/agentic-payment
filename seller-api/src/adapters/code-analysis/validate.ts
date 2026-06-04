import type { CodeAnalysisRequest } from "./types";

const MAX_CODE_CHARS = 5000;
const MAX_LANGUAGE_CHARS = 60;

export function validateCodeAnalysisRequest(
  body: unknown,
): { ok: true; data: CodeAnalysisRequest } | { ok: false; missing: string[] } {
  const missing: string[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, missing: ["code"] };
  }

  const b = body as Record<string, unknown>;

  if (typeof b.code !== "string" || b.code.trim().length === 0) {
    missing.push("code");
  } else if (b.code.length > MAX_CODE_CHARS) {
    missing.push(`code must be at most ${MAX_CODE_CHARS} characters`);
  }

  if (b.language !== undefined) {
    if (typeof b.language !== "string") {
      missing.push("language must be a string");
    } else if (b.language.trim().length > MAX_LANGUAGE_CHARS) {
      missing.push(
        `language must be at most ${MAX_LANGUAGE_CHARS} characters`,
      );
    }
  }

  if (missing.length > 0) return { ok: false, missing };

  const language =
    typeof b.language === "string" && b.language.trim().length > 0
      ? b.language.trim()
      : undefined;

  return {
    ok: true,
    data: {
      code: (b.code as string).trim(),
      ...(language ? { language } : {}),
    },
  };
}
