export interface ExtractDataRequest {
  text: string;
  fields: string[];
}

export interface ExtractDataResult {
  extracted: Record<string, string | null>;
  tokensUsed: {
    input: number;
    output: number;
  };
  model: string;
}
