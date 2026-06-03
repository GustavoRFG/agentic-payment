import type { AnalysisMode, TextAnalysisRequest } from "./types";

const VALID_MODES = new Set(["summary", "sentiment", "entities", "full"]);
const MAX_CHARS = 2000;

export function validateTextAnalysisRequest(
  body: unknown,
): { ok: true; data: TextAnalysisRequest } | { ok: false; missing: string[] } {
  const missing: string[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, missing: ["text"] };
  }

  const b = body as Record<string, unknown>;

  if (typeof b.text !== "string" || b.text.trim().length === 0) {
    missing.push("text");
  } else if (b.text.length > MAX_CHARS) {
    missing.push(`text must be at most ${MAX_CHARS} characters`);
  }

  if (b.mode !== undefined && !VALID_MODES.has(b.mode as string)) {
    missing.push(`mode must be one of: ${[...VALID_MODES].join(", ")}`);
  }

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    data: {
      text: (b.text as string).trim(),
      mode: (b.mode as AnalysisMode | undefined) ?? "full",
    },
  };
}
