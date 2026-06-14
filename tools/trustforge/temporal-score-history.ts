/**
 * temporal-score-history — append-only TrustScore history per service plus a
 * cross-service portfolio roll-up, with deterministic regression/consistency
 * detection. Pure functions (no I/O) so they are unit-testable; callers own
 * reading/writing the JSON files.
 */

import type { TrustScore } from "./consolidate-bootstrap-trust-score";

export const SCORE_HISTORY_SCHEMA_VERSION = "0.1.0";
export const PORTFOLIO_SCHEMA_VERSION = "0.1.0";
const DEFAULT_REGRESSION_THRESHOLD = 0.05;

export interface ScoreHistoryEntry {
  readonly created_at_utc: string;
  readonly composite: number;
  readonly sample_size: number;
  readonly confidence: "low" | "medium" | "high";
  readonly regression_flag: boolean;
  readonly methodology_version: string;
  readonly evidence_refs: readonly string[];
}

export interface ScoreHistory {
  readonly schema_name: "trustforge_score_history";
  readonly schema_version: string;
  readonly service_id: string;
  readonly entries: readonly ScoreHistoryEntry[];
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Append a TrustScore as a new history entry. Regression is detected relative to
 * the most recent prior entry's composite (drop greater than the threshold).
 * Returns a new history object (input is not mutated).
 */
export function appendScoreHistory(
  existing: ScoreHistory | null,
  score: TrustScore,
  options: { readonly regressionThreshold?: number } = {},
): ScoreHistory {
  const threshold = options.regressionThreshold ?? DEFAULT_REGRESSION_THRESHOLD;
  if (existing && existing.service_id !== score.service_id) {
    throw new Error(
      `history service_id ${existing.service_id} does not match score ${score.service_id}`,
    );
  }
  const priorEntries = existing?.entries ?? [];
  const prior = priorEntries[priorEntries.length - 1];
  const regression_flag =
    prior !== undefined ? score.composite < prior.composite - threshold : false;

  const entry: ScoreHistoryEntry = {
    created_at_utc: score.created_at_utc,
    composite: score.composite,
    sample_size: score.sample_size,
    confidence: score.confidence,
    regression_flag,
    methodology_version: score.methodology_version,
    evidence_refs: score.evidence_refs,
  };

  return {
    schema_name: "trustforge_score_history",
    schema_version: SCORE_HISTORY_SCHEMA_VERSION,
    service_id: score.service_id,
    entries: [...priorEntries, entry],
  };
}

export type Consistency = "pass" | "regressed" | "insufficient_data";

export interface ConsistencyResult {
  readonly consistency: Consistency;
  readonly regression_flag: boolean;
  readonly sample_size: number;
  readonly detail: string;
}

/**
 * Consistency over a single service's history: `pass` when there are at least
 * two entries and none regressed; `regressed` when any entry regressed;
 * `insufficient_data` for a single entry.
 */
export function detectHistoryConsistency(history: ScoreHistory): ConsistencyResult {
  const n = history.entries.length;
  const anyRegression = history.entries.some((e) => e.regression_flag);
  if (anyRegression) {
    return {
      consistency: "regressed",
      regression_flag: true,
      sample_size: n,
      detail: "at least one history entry regressed beyond threshold",
    };
  }
  if (n < 2) {
    return {
      consistency: "insufficient_data",
      regression_flag: false,
      sample_size: n,
      detail: "single bootstrap sample; temporal consistency not yet established",
    };
  }
  return {
    consistency: "pass",
    regression_flag: false,
    sample_size: n,
    detail: "all history entries within regression threshold",
  };
}

export interface PortfolioServiceEntry {
  readonly service_id: string;
  readonly composite: number;
  readonly sample_size: number;
  readonly confidence: "low" | "medium" | "high";
  readonly regression_flag: boolean;
}

export interface PortfolioTrustScore {
  readonly schema_name: "trustforge_portfolio_trust_score";
  readonly schema_version: string;
  readonly window: { readonly type: string; readonly from_utc: string | null; readonly to_utc: string | null };
  readonly services: readonly PortfolioServiceEntry[];
  readonly service_count: number;
  readonly total_sample_size: number;
  readonly composite: number;
  readonly confidence: "low" | "medium" | "high";
  readonly regression_flag: boolean;
  readonly methodology_version: string;
  readonly created_at_utc: string;
}

function confidenceForSampleSize(n: number): "low" | "medium" | "high" {
  if (n < 5) return "low";
  if (n < 20) return "medium";
  return "high";
}

/** Cross-service portfolio roll-up. Composite is the mean of per-service composites. */
export function buildPortfolioTrustScore(
  scores: readonly TrustScore[],
  options: { readonly now?: () => Date } = {},
): PortfolioTrustScore {
  if (scores.length === 0) {
    throw new Error("cannot build a portfolio score from zero services");
  }
  const methodologyVersion = scores[0].methodology_version;
  if (!scores.every((s) => s.methodology_version === methodologyVersion)) {
    throw new Error("all portfolio scores must share the same methodology_version");
  }

  const services: PortfolioServiceEntry[] = scores.map((s) => ({
    service_id: s.service_id,
    composite: s.composite,
    sample_size: s.sample_size,
    confidence: s.confidence,
    regression_flag: s.regression_flag,
  }));

  const totalSampleSize = scores.reduce((acc, s) => acc + s.sample_size, 0);
  const composite = round6(
    scores.reduce((acc, s) => acc + s.composite, 0) / scores.length,
  );
  const timestamps = scores
    .map((s) => s.created_at_utc)
    .filter((t): t is string => typeof t === "string")
    .sort();
  const now = options.now ?? (() => new Date());

  return {
    schema_name: "trustforge_portfolio_trust_score",
    schema_version: PORTFOLIO_SCHEMA_VERSION,
    window: {
      type: "portfolio_bootstrap",
      from_utc: timestamps[0] ?? null,
      to_utc: timestamps[timestamps.length - 1] ?? null,
    },
    services,
    service_count: services.length,
    total_sample_size: totalSampleSize,
    composite,
    confidence: confidenceForSampleSize(totalSampleSize),
    regression_flag: services.some((s) => s.regression_flag),
    methodology_version: methodologyVersion,
    created_at_utc: now().toISOString(),
  };
}
