import Anthropic from "@anthropic-ai/sdk";
import type {
  CodeAnalysisIssue,
  CodeAnalysisRequest,
  CodeAnalysisResult,
  CodeComplexity,
} from "./types";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 700;
const COMPLEXITIES = new Set(["low", "medium", "high"]);
const SEVERITIES = new Set(["low", "medium", "high"]);

function adapterMockEnabled(): boolean {
  return (
    process.env.AGENTIC_ADAPTER_MOCK === "1" ||
    process.env.AGENTIC_TEXT_ANALYSIS_MOCK === "1"
  );
}

function buildPrompt(req: CodeAnalysisRequest): string {
  const language = req.language ?? "unknown";
  return [
    "Analyze the following code and respond ONLY with a valid JSON object.",
    'Return: { "issues": [{ "message": string, "severity": "low"|"medium"|"high", "line"?: number }], "suggestions": string[], "complexity": "low"|"medium"|"high" }.',
    "Focus on bugs, correctness risks, maintainability improvements, and an overall complexity estimate.",
    `Language: ${language}`,
    `Code: """${req.code}"""`,
    "Respond with only the JSON object, no markdown, no extra text.",
  ].join("\n");
}

function mockCodeAnalysis(): CodeAnalysisResult {
  return {
    issues: [],
    suggestions: ["Mock code analysis suggestion for CI."],
    complexity: "low",
    tokensUsed: {
      input: 0,
      output: 0,
    },
    model: "mock-code-analysis",
  };
}

function normalizeIssues(value: unknown): CodeAnalysisIssue[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => {
      return item !== null && typeof item === "object";
    })
    .map((item) => {
      const severity = SEVERITIES.has(String(item.severity))
        ? (item.severity as CodeAnalysisIssue["severity"])
        : "medium";
      return {
        message:
          typeof item.message === "string"
            ? item.message
            : "Unspecified code issue.",
        severity,
        ...(typeof item.line === "number" && Number.isFinite(item.line)
          ? { line: item.line }
          : {}),
      };
    });
}

function normalizeSuggestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeComplexity(value: unknown): CodeComplexity {
  return COMPLEXITIES.has(String(value)) ? (value as CodeComplexity) : "medium";
}

export async function analyzeCode(
  req: CodeAnalysisRequest,
): Promise<CodeAnalysisResult> {
  if (adapterMockEnabled()) {
    return mockCodeAnalysis();
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
      issues: [],
      suggestions: [raw],
      complexity: "medium",
    };
  }

  return {
    issues: normalizeIssues(parsed.issues),
    suggestions: normalizeSuggestions(parsed.suggestions),
    complexity: normalizeComplexity(parsed.complexity),
    tokensUsed: {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
    },
    model: MODEL,
  };
}
