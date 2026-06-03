import Anthropic from "@anthropic-ai/sdk";
import type {
  AnalysisMode,
  TextAnalysisRequest,
  TextAnalysisResult,
} from "./types";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 512;

function buildPrompt(text: string, mode: AnalysisMode): string {
  const parts: string[] = [
    "Analyze the following text and respond ONLY with a valid JSON object.",
    `Text: """${text}"""`,
    "",
  ];

  if (mode === "summary" || mode === "full") {
    parts.push('Include "summary": a concise 1-2 sentence summary.');
  }
  if (mode === "sentiment" || mode === "full") {
    parts.push(
      'Include "sentiment": { "label": "positive"|"negative"|"neutral"|"mixed", "confidence": "low"|"medium"|"high", "rationale": "one sentence" }.',
    );
  }
  if (mode === "entities" || mode === "full") {
    parts.push(
      'Include "entities": array of { "text": string, "type": "person"|"organization"|"location"|"date"|"other" }.',
    );
  }

  parts.push("Respond with only the JSON object, no markdown, no extra text.");
  return parts.join("\n");
}

function mockTextAnalysis(
  req: TextAnalysisRequest,
  requestId: string,
): TextAnalysisResult {
  const mode = req.mode ?? "full";
  return {
    requestId,
    mode,
    generatedAt: new Date().toISOString(),
    inputCharacters: req.text.length,
    summary:
      mode === "summary" || mode === "full"
        ? "Mock text analysis summary for CI."
        : undefined,
    sentiment:
      mode === "sentiment" || mode === "full"
        ? {
            label: "neutral",
            confidence: "high",
            rationale: "Mock analysis does not infer real sentiment.",
          }
        : undefined,
    entities: mode === "entities" || mode === "full" ? [] : undefined,
    tokensUsed: {
      input: 0,
      output: 0,
    },
    model: "mock-text-analysis",
  };
}

export async function analyzeText(
  req: TextAnalysisRequest,
  requestId: string,
): Promise<TextAnalysisResult> {
  if (process.env.AGENTIC_TEXT_ANALYSIS_MOCK === "1") {
    return mockTextAnalysis(req, requestId);
  }

  const client = new Anthropic();
  const mode = req.mode ?? "full";
  const prompt = buildPrompt(req.text, mode);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("");

  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = { summary: raw };
  }

  return {
    requestId,
    mode,
    generatedAt: new Date().toISOString(),
    inputCharacters: req.text.length,
    summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
    sentiment:
      parsed.sentiment && typeof parsed.sentiment === "object"
        ? (parsed.sentiment as TextAnalysisResult["sentiment"])
        : undefined,
    entities: Array.isArray(parsed.entities)
      ? (parsed.entities as TextAnalysisResult["entities"])
      : undefined,
    tokensUsed: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
    },
    model: MODEL,
  };
}
