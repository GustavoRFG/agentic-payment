export type CodeComplexity = "low" | "medium" | "high";
export type CodeIssueSeverity = "low" | "medium" | "high";

export interface CodeAnalysisRequest {
  code: string;
  language?: string;
}

export interface CodeAnalysisIssue {
  message: string;
  severity: CodeIssueSeverity;
  line?: number;
}

export interface CodeAnalysisResult {
  issues: CodeAnalysisIssue[];
  suggestions: string[];
  complexity: CodeComplexity;
  tokensUsed: {
    input: number;
    output: number;
  };
  model: string;
}
