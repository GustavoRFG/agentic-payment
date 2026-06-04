export interface SummarizeRequest {
  text: string;
  maxPoints?: number;
}

export interface SummarizeResult {
  points: string[];
  wordCount: number;
  tokensUsed: {
    input: number;
    output: number;
  };
  model: string;
}
