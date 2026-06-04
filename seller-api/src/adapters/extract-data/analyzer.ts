import Anthropic from "@anthropic-ai/sdk";
import type { ExtractDataRequest, ExtractDataResult } from "./types";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 700;

function adapterMockEnabled(): boolean {
  return (
    process.env.AGENTIC_ADAPTER_MOCK === "1" ||
    process.env.AGENTIC_TEXT_ANALYSIS_MOCK === "1"
  );
}

function buildPrompt(req: ExtractDataRequest): string {
  return [
    "Extract data from the following text and respond ONLY with a valid JSON object.",
    'Return: { "extracted": Record<string, string|null> }.',
    "Use exactly the requested field names as keys. Use null when a field is not found.",
    `Fields: ${JSON.stringify(req.fields)}`,
    `Text: """${req.text}"""`,
    "Respond with only the JSON object, no markdown, no extra text.",
  ].join("\n");
}

function emptyExtraction(fields: string[]): Record<string, string | null> {
  return Object.fromEntries(fields.map((field) => [field, null]));
}

function mockExtractData(req: ExtractDataRequest): ExtractDataResult {
  return {
    extracted: emptyExtraction(req.fields),
    tokensUsed: {
      input: 0,
      output: 0,
    },
    model: "mock-extract-data",
  };
}

function normalizeExtraction(
  value: unknown,
  fields: string[],
): Record<string, string | null> {
  const out = emptyExtraction(fields);
  if (!value || typeof value !== "object") return out;
  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const candidate = record[field];
    out[field] =
      typeof candidate === "string" || candidate === null ? candidate : null;
  }
  return out;
}

export async function extractData(
  req: ExtractDataRequest,
): Promise<ExtractDataResult> {
  if (adapterMockEnabled()) {
    return mockExtractData(req);
  }

  const client = new Anthropic();
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: buildPrompt(req) }],
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = { extracted: emptyExtraction(req.fields) };
  }

  return {
    extracted: normalizeExtraction(parsed.extracted, req.fields),
    tokensUsed: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
    },
    model: MODEL,
  };
}
