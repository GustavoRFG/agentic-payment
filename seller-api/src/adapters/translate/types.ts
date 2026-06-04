export interface TranslateRequest {
  text: string;
  targetLanguage: string;
}

export interface TranslateResult {
  translation: string;
  detectedSourceLanguage: string;
  tokensUsed: {
    input: number;
    output: number;
  };
  model: string;
}
