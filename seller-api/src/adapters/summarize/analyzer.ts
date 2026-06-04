import Anthropic from "@anthropic-ai/sdk";
import type { SummarizeRequest, SummarizeResult } from "./types";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 700;

function adapterMockEnabled(): boolean {
  return (
    process.env.AGENTIC_ADAPTER_MOCK === "1" ||
    process.env.AGENTIC_TEXT_ANALYSIS_MOCK === "1"
  );
}

function countWords(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length;
}

function buildPrompt(req: SummarizeRequest): string {
  const maxPoints = req.maxPoints ?? 5;
  return [
    "Summarize the following text and respond ONLY with a valid JSON object.",
    `Return: { "points": string[], "wordCount": number }. Use at most ${maxPoints} concise bullet points.`,
    `Text: """${req.text}"""`,
    "Respond with only the JSON object, no markdown, no extra text.",
  ].join("\n");
}

function mockSummarize(req: SummarizeRequest): SummarizeResult {
  return {
    points: Array.from({ length: req.maxPoints ?? 5 }, (_, index) => {
      return `Mock summary point ${index + 1} for CI.`;
    }),
    wordCount: countWords(req.text),
    tokensUsed: {
      input: 0,
      output: 0,
    },
    model: "mock-summarize",
  };
}

function normalizePoints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export async function summarizeText(
  req: SummarizeRequest,
): Promise<SummarizeResult> {
  if (adapterMockEnabled()) {
    return mockSummarize(req);
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
    parsed = { points: [raw], wordCount: countWords(req.text) };
  }

  return {
    points: normalizePoints(parsed.points),
    wordCount:
      typeof parsed.wordCount === "number" && Number.isFinite(parsed.wordCount)
        ? parsed.wordCount
        : countWords(req.text),
    tokensUsed: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
    },
    model: MODEL,
  };
}
