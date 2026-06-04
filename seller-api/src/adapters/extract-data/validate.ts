import type { ExtractDataRequest } from "./types";

const MAX_TEXT_CHARS = 5000;
const MAX_FIELDS = 20;
const MAX_FIELD_CHARS = 80;

export function validateExtractDataRequest(
  body: unknown,
): { ok: true; data: ExtractDataRequest } | { ok: false; missing: string[] } {
  const missing: string[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, missing: ["text", "fields"] };
  }

  const b = body as Record<string, unknown>;

  if (typeof b.text !== "string" || b.text.trim().length === 0) {
    missing.push("text");
  } else if (b.text.length > MAX_TEXT_CHARS) {
    missing.push(`text must be at most ${MAX_TEXT_CHARS} characters`);
  }

  if (!Array.isArray(b.fields) || b.fields.length === 0) {
    missing.push("fields");
  } else if (b.fields.length > MAX_FIELDS) {
    missing.push(`fields must contain at most ${MAX_FIELDS} entries`);
  } else {
    const invalidField = b.fields.find((field) => {
      return (
        typeof field !== "string" ||
        field.trim().length === 0 ||
        field.trim().length > MAX_FIELD_CHARS
      );
    });
    if (invalidField !== undefined) {
      missing.push(
        `fields entries must be non-empty strings up to ${MAX_FIELD_CHARS} characters`,
      );
    }
  }

  if (missing.length > 0) return { ok: false, missing };

  const fields = (b.fields as string[]).map((field) => field.trim());

  return {
    ok: true,
    data: {
      text: (b.text as string).trim(),
      fields: [...new Set(fields)],
    },
  };
}
