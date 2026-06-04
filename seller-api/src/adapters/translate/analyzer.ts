import Anthropic from "@anthropic-ai/sdk";
import type { TranslateRequest, TranslateResult } from "./types";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 700;

function adapterMockEnabled(): boolean {
  return (
    process.env.AGENTIC_ADAPTER_MOCK === "1" ||
    process.env.AGENTIC_TEXT_ANALYSIS_MOCK === "1"
  );
}

function buildPrompt(req: TranslateRequest): string {
  return [
    "Translate the following text and respond ONLY with a valid JSON object.",
    'Return: { "translation": string, "detectedSourceLanguage": string }.',
    `Target language: ${req.targetLanguage}`,
    `Text: """${req.text}"""`,
    "Respond with only the JSON object, no markdown, no extra text.",
  ].join("\n");
}

function mockTranslate(req: TranslateRequest): TranslateResult {
  return {
    translation: `Mock translation to ${req.targetLanguage}: ${req.text}`,
    detectedSourceLanguage: "unknown",
    tokensUsed: {
      input: 0,
      output: 0,
    },
    model: "mock-translate",
  };
}

export async function translateText(
  req: TranslateRequest,
): Promise<TranslateResult> {
  if (adapterMockEnabled()) {
    return mockTranslate(req);
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
    parsed = {
      translation: raw,
      detectedSourceLanguage: "unknown",
    };
  }

  return {
    translation:
      typeof parsed.translation === "string" ? parsed.translation : raw,
    detectedSourceLanguage:
      typeof parsed.detectedSourceLanguage === "string"
        ? parsed.detectedSourceLanguage
        : "unknown",
    tokensUsed: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
    },
    model: MODEL,
  };
}
