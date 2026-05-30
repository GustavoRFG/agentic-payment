export type RangeStatus = "in_range" | "near_edge" | "out_of_range";
export type Severity = "low" | "medium" | "high" | "critical";
export type CheckStatus = "pass" | "warn" | "fail";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type DefiGuardianReportMode =
  | "adapter-mock"
  | "adapter-real-file"
  | "adapter-real-cli";
export type RecommendationAction =
  | "hold"
  | "monitor"
  | "rebalance-review"
  | "urgent-review";

export interface RiskReportRequest {
  wallet?: unknown;
  position?: {
    protocol?: unknown;
    chain?: unknown;
    tokenId?: unknown;
    pair?: unknown;
    rangeStatus?: unknown;
    liquidityUsd?: unknown;
    feesUsd?: unknown;
    impermanentLossEstimatePct?: unknown;
    healthFlags?: unknown;
  };
}

export interface NormalizedPosition {
  protocol: string;
  chain: string;
  tokenId: string;
  pair: string;
  rangeStatus: RangeStatus;
  liquidityUsd: number;
  feesUsd: number;
  impermanentLossEstimatePct: number | null;
  healthFlags: string[];
}

export interface NormalizedRiskReportRequest {
  wallet: string;
  position: NormalizedPosition;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  drivers: string[];
}

export interface RiskReport {
  reportId: string;
  mode: DefiGuardianReportMode;
  generatedAt: string;
  wallet: string;
  position: {
    protocol: string;
    chain: string;
    tokenId: string;
    pair: string;
  };
  risk: RiskAssessment;
  range: {
    status: RangeStatus;
    severity: Severity;
    explanation: string;
  };
  liquidity: {
    estimatedUsd: number;
    severity: Severity;
    explanation: string;
  };
  fees: {
    estimatedUsd: number;
    comment: string;
  };
  recommendation: {
    action: RecommendationAction;
    confidence: "low" | "medium" | "high";
    rationale: string;
  };
  warnings: string[];
  checks: Array<{
    name: string;
    status: CheckStatus;
    detail: string;
  }>;
}
