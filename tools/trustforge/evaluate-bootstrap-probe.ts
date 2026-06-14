/**
 * evaluate-bootstrap-probe — deterministic, LLM-free evaluation of a single
 * TrustForge ProbeRun against a ServiceEvalTask, producing an EvaluationResult.
 *
 * Dimension rules (spec section 16):
 *   correctness        = 1 iff observed chain id == 1 AND ground truth before/after both == 1
 *   reliability        = 1 iff HTTP 200 (and a response was received)
 *   payment_integrity  = 1 iff on-chain transfer verified (ONCHAIN_VERIFIED)
 *   safety             = 1 iff attempt_count == 1, request count == 1, no retry, no fallback
 *   latency            = clamp(max_acceptable_latency / actual_latency, 0, 1)
 *   composite          = sum(verifier.weight * verifier.score)
 */

export interface ProbeRunLike {
  readonly probe_id: string;
  readonly service_id: string;
  readonly response?: {
    readonly http_status?: number | null;
    readonly latency_ms?: number | null;
    readonly observed_chain_id?: number | string | null;
  };
  readonly verification?: {
    readonly ground_truth_before?: number | string | null;
    readonly ground_truth_after?: number | string | null;
    readonly observed_chain_id?: number | string | null;
    readonly observed_value?: number | string | null;
    readonly verification_profile?: string;
    readonly semantic_correctness?: "pass" | "fail" | "unknown";
    readonly onchain_transfer_verification?: string;
  };
  readonly safety?: {
    readonly attempt_count?: number;
    readonly payment_bearing_http_request_count?: number;
    readonly retry_used?: boolean;
    readonly fallback_used?: boolean;
  };
}

export interface EvalTaskVerifier {
  readonly name: string;
  readonly weight: number;
  readonly dimension?: EvaluationDimension;
  readonly description?: string;
}

export interface EvalTaskLike {
  readonly task_id: string;
  readonly service_id: string;
  readonly verifiers: readonly EvalTaskVerifier[];
  readonly max_acceptable_latency_ms: number;
  readonly methodology_version: string;
}

export type EvaluationDimension =
  | "correctness"
  | "reliability"
  | "payment_integrity"
  | "latency"
  | "safety";

export interface VerifierResult {
  readonly name: string;
  readonly weight: number;
  readonly passed: boolean;
  readonly score: number;
  readonly detail: string;
}

export interface EvaluationDimensions {
  readonly correctness: number;
  readonly reliability: number;
  readonly payment_integrity: number;
  readonly latency: number;
  readonly safety: number;
}

export interface EvaluationResult {
  readonly schema_name: "trustforge_evaluation_result";
  readonly schema_version: string;
  readonly evaluation_id: string;
  readonly probe_id: string;
  readonly task_id: string;
  readonly service_id: string;
  readonly verifier_results: readonly VerifierResult[];
  readonly dimensions: EvaluationDimensions;
  readonly composite: number;
  readonly status: "pass" | "fail";
  readonly methodology_version: string;
  readonly created_at_utc: string;
}

export const EVALUATION_SCHEMA_VERSION = "0.1.0";

const VERIFIER_DIMENSION_BY_NAME: Record<string, EvaluationDimension> = {
  ethereum_chain_id_matches: "correctness",
  ethereum_block_number_within_tolerance: "correctness",
  http_200: "reliability",
  settlement_verified: "payment_integrity",
  one_shot_safety: "safety",
  latency_within_budget: "latency",
};

export function normalizeChainId(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "0x1") return 1;
    if (/^0x[0-9a-fA-F]+$/.test(value)) return Number.parseInt(value, 16);
    const dec = Number.parseInt(value, 10);
    return Number.isInteger(dec) ? dec : null;
  }
  return null;
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export interface EvaluateOptions {
  readonly now?: () => Date;
  readonly evaluationId?: string;
}

export function evaluateBootstrapProbe(
  probe: ProbeRunLike,
  task: EvalTaskLike,
  options: EvaluateOptions = {},
): EvaluationResult {
  if (probe.service_id !== task.service_id) {
    throw new Error(
      `service_id mismatch: probe=${probe.service_id} task=${task.service_id}`,
    );
  }

  const httpStatus = probe.response?.http_status ?? null;
  const observedChainId = normalizeChainId(
    probe.verification?.observed_chain_id ?? probe.response?.observed_chain_id,
  );
  const gtBefore = normalizeChainId(probe.verification?.ground_truth_before);
  const gtAfter = normalizeChainId(probe.verification?.ground_truth_after);
  const onchain = probe.verification?.onchain_transfer_verification ?? "not_executed";
  const latencyMs = probe.response?.latency_ms ?? null;
  const attempt = probe.safety?.attempt_count ?? 0;
  const reqCount = probe.safety?.payment_bearing_http_request_count ?? 0;
  const retryUsed = probe.safety?.retry_used ?? false;
  const fallbackUsed = probe.safety?.fallback_used ?? false;

  // Correctness is profile-aware. The default/chain-id profile recomputes the
  // mainnet-id agreement from the recorded values; the block-number profile (and
  // any other richer profile) relies on the deterministic semantic verdict the
  // executor already recorded as `semantic_correctness`.
  const profile = probe.verification?.verification_profile ?? "ethereum_chain_id";
  const correctness =
    profile === "ethereum_chain_id"
      ? observedChainId === 1 && gtBefore === 1 && gtAfter === 1
        ? 1
        : 0
      : probe.verification?.semantic_correctness === "pass"
        ? 1
        : 0;
  const reliability = httpStatus === 200 ? 1 : 0;
  const payment_integrity = onchain === "ONCHAIN_VERIFIED" ? 1 : 0;
  const safety =
    attempt === 1 && reqCount === 1 && retryUsed === false && fallbackUsed === false
      ? 1
      : 0;
  const latency =
    typeof latencyMs === "number" && latencyMs > 0
      ? round6(clamp01(task.max_acceptable_latency_ms / latencyMs))
      : 0;

  const dimensions: EvaluationDimensions = {
    correctness,
    reliability,
    payment_integrity,
    latency,
    safety,
  };

  const dimensionScore = (dim: EvaluationDimension): number => dimensions[dim];

  const verifier_results: VerifierResult[] = task.verifiers.map((verifier) => {
    const dimension =
      verifier.dimension ?? VERIFIER_DIMENSION_BY_NAME[verifier.name];
    if (!dimension) {
      throw new Error(`verifier ${verifier.name} has no mapped dimension`);
    }
    const score = dimensionScore(dimension);
    return {
      name: verifier.name,
      weight: verifier.weight,
      passed: score >= 1,
      score,
      detail: `${dimension}=${score}`,
    };
  });

  const composite = round6(
    verifier_results.reduce((acc, v) => acc + v.weight * v.score, 0),
  );

  const allRequiredPassed = verifier_results.every((v) => v.passed);
  const status: "pass" | "fail" = allRequiredPassed ? "pass" : "fail";

  const now = options.now ?? (() => new Date());

  return {
    schema_name: "trustforge_evaluation_result",
    schema_version: EVALUATION_SCHEMA_VERSION,
    evaluation_id:
      options.evaluationId ?? `${probe.probe_id}__${task.task_id}`,
    probe_id: probe.probe_id,
    task_id: task.task_id,
    service_id: probe.service_id,
    verifier_results,
    dimensions,
    composite,
    status,
    methodology_version: task.methodology_version,
    created_at_utc: now().toISOString(),
  };
}
