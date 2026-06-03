export type AnalysisMode = "summary" | "sentiment" | "entities" | "full";

export interface TextAnalysisRequest {
  text: string;
  mode?: AnalysisMode;
}

export interface TextAnalysisResult {
  requestId: string;
  mode: AnalysisMode;
  generatedAt: string;
  inputCharacters: number;
  summary?: string;
  sentiment?: {
    label: "positive" | "negative" | "neutral" | "mixed";
    confidence: "low" | "medium" | "high";
    rationale: string;
  };
  entities?: Array<{
    text: string;
    type: "person" | "organization" | "location" | "date" | "other";
  }>;
  tokensUsed: {
    input: number;
    output: number;
  };
  model: string;
}
