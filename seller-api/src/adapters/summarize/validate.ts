import type { SummarizeRequest } from "./types";

const MAX_TEXT_CHARS = 10000;
const DEFAULT_MAX_POINTS = 5;
const MAX_POINTS_LIMIT = 20;

export function validateSummarizeRequest(
  body: unknown,
): { ok: true; data: SummarizeRequest } | { ok: false; missing: string[] } {
  const missing: string[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, missing: ["text"] };
  }

  const b = body as Record<string, unknown>;

  if (typeof b.text !== "string" || b.text.trim().length === 0) {
    missing.push("text");
  } else if (b.text.length > MAX_TEXT_CHARS) {
    missing.push(`text must be at most ${MAX_TEXT_CHARS} characters`);
  }

  if (b.maxPoints !== undefined) {
    if (
      typeof b.maxPoints !== "number" ||
      !Number.isInteger(b.maxPoints) ||
      b.maxPoints < 1 ||
      b.maxPoints > MAX_POINTS_LIMIT
    ) {
      missing.push(`maxPoints must be an integer from 1 to ${MAX_POINTS_LIMIT}`);
    }
  }

  if (missing.length > 0) return { ok: false, missing };

  return {
    ok: true,
    data: {
      text: (b.text as string).trim(),
      maxPoints:
        typeof b.maxPoints === "number" ? b.maxPoints : DEFAULT_MAX_POINTS,
    },
  };
}
