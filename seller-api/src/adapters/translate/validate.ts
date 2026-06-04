import type { TranslateRequest } from "./types";

const MAX_TEXT_CHARS = 5000;
const MAX_LANGUAGE_CHARS = 80;

export function validateTranslateRequest(
  body: unknown,
): { ok: true; data: TranslateRequest } | { ok: false; missing: string[] } {
  const missing: string[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, missing: ["text", "targetLanguage"] };
  }

  const b = body as Record<string, unknown>;

  if (typeof b.text !== "string" || b.text.trim().length === 0) {
    missing.push("text");
  } else if (b.text.length > MAX_TEXT_CHARS) {
    missing.push(`text must be at most ${MAX_TEXT_CHARS} characters`);
  }

  if (
    typeof b.targetLanguage !== "string" ||
    b.targetLanguage.trim().length === 0
  ) {
    missing.push("targetLanguage");
  } else if (b.targetLanguage.trim().length > MAX_LANGUAGE_CHARS) {
    missing.push(
      `targetLanguage must be at most ${MAX_LANGUAGE_CHARS} characters`,
    );
  }

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    data: {
      text: (b.text as string).trim(),
      targetLanguage: (b.targetLanguage as string).trim(),
    },
  };
}
