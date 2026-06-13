/**
 * consolidate-bootstrap-trust-score — consolidate one or more EvaluationResults
 * into a single TrustScore. For the bootstrap (first probe) this yields
 * sample_size = 1, confidence = low, regression_flag = false.
 */

import type {
  EvaluationDimensions,
  EvaluationResult,
} from "./evaluate-bootstrap-probe";

export interface CommercialDisclosure {
  readonly evaluated_service_is_customer: boolean;
  readonly relationship_type: string;
  readonly seller_funded_probes: boolean;
  readonly seller_funded_probe_share: number;
  readonly score_methodology_unchanged: boolean;
  readonly disclosure_notes: string;
}

export interface TrustScore {
  readonly schema_name: "trustforge_trust_score";
  readonly schema_version: string;
  readonly service_id: string;
  readonly window: {
    readonly type: string;
    readonly from_utc: string | null;
    readonly to_utc: string | null;
  };
  readonly dimensions: EvaluationDimensions;
  readonly composite: number;
  readonly sample_size: number;
  readonly confidence: "low" | "medium" | "high";
  readonly regression_flag: boolean;
  readonly methodology_version: string;
  readonly commercial_disclosure: CommercialDisclosure;
  readonly evidence_refs: readonly string[];
  readonly created_at_utc: string;
}

export const TRUST_SCORE_SCHEMA_VERSION = "0.1.0";

export const DEFAULT_BOOTSTRAP_DISCLOSURE: CommercialDisclosure = {
  evaluated_service_is_customer: false,
  relationship_type: "none",
  seller_funded_probes: false,
  seller_funded_probe_share: 0.0,
  score_methodology_unchanged: true,
  disclosure_notes: "Bootstrap external paid probe.",
};

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function confidenceForSampleSize(n: number): "low" | "medium" | "high" {
  if (n < 5) return "low";
  if (n < 20) return "medium";
  return "high";
}

export interface ConsolidateOptions {
  readonly now?: () => Date;
  readonly windowType?: string;
  readonly commercialDisclosure?: CommercialDisclosure;
  readonly extraEvidenceRefs?: readonly string[];
  /** Prior composite for regression detection; omit for the first score. */
  readonly priorComposite?: number;
  readonly regressionThreshold?: number;
}

export function consolidateBootstrapTrustScore(
  evaluations: readonly EvaluationResult[],
  options: ConsolidateOptions = {},
): TrustScore {
  if (evaluations.length === 0) {
    throw new Error("cannot consolidate a TrustScore from zero evaluations");
  }

  const serviceId = evaluations[0].service_id;
  if (!evaluations.every((e) => e.service_id === serviceId)) {
    throw new Error("all evaluations must share the same service_id");
  }
  const methodologyVersion = evaluations[0].methodology_version;
  if (!evaluations.every((e) => e.methodology_version === methodologyVersion)) {
    throw new Error("all evaluations must share the same methodology_version");
  }

  const n = evaluations.length;
  const avg = (pick: (d: EvaluationDimensions) => number): number =>
    round6(evaluations.reduce((acc, e) => acc + pick(e.dimensions), 0) / n);

  const dimensions: EvaluationDimensions = {
    correctness: avg((d) => d.correctness),
    reliability: avg((d) => d.reliability),
    payment_integrity: avg((d) => d.payment_integrity),
    latency: avg((d) => d.latency),
    safety: avg((d) => d.safety),
  };

  const composite = round6(
    evaluations.reduce((acc, e) => acc + e.composite, 0) / n,
  );

  const threshold = options.regressionThreshold ?? 0.05;
  const regression_flag =
    options.priorComposite !== undefined
      ? composite < options.priorComposite - threshold
      : false;

  const timestamps = evaluations
    .map((e) => e.created_at_utc)
    .filter((t): t is string => typeof t === "string")
    .sort();

  const evidence_refs = [
    ...evaluations.map((e) => `evaluation:${e.evaluation_id}`),
    ...evaluations.map((e) => `probe:${e.probe_id}`),
    ...(options.extraEvidenceRefs ?? []),
  ];

  const now = options.now ?? (() => new Date());

  return {
    schema_name: "trustforge_trust_score",
    schema_version: TRUST_SCORE_SCHEMA_VERSION,
    service_id: serviceId,
    window: {
      type: options.windowType ?? "bootstrap",
      from_utc: timestamps[0] ?? null,
      to_utc: timestamps[timestamps.length - 1] ?? null,
    },
    dimensions,
    composite,
    sample_size: n,
    confidence: confidenceForSampleSize(n),
    regression_flag,
    methodology_version: methodologyVersion,
    commercial_disclosure:
      options.commercialDisclosure ?? DEFAULT_BOOTSTRAP_DISCLOSURE,
    evidence_refs,
    created_at_utc: now().toISOString(),
  };
}
