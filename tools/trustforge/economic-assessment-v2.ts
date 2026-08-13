/**
 * economic-assessment-v2 — B.6 candidate comparison assessment.
 * Transparent ordinal/category model. Not payment authority.
 */

import type { CandidatePolicyVerdict } from "./payment-candidate-policy";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";
import type { PriceMovementEvidence } from "./quote-observation-semantics";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export type UtilityEvidenceClass =
  | "ADVERTISED_UTILITY"
  | "OBSERVED_UTILITY"
  | "INFERRED_UTILITY"
  | "UNKNOWN_UTILITY";

export type OrdinalValue = "none" | "low" | "medium" | "high";

export interface CandidateEconomicAssessmentV2 {
  readonly schema_version: "trustforge_candidate_economic_assessment.v2";
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly currentCost: string | "unknown";
  readonly costAsset: string | "unknown";
  readonly priceObservationAgeMs: number | null;
  readonly priceMovementEvidence: PriceMovementEvidence | null;
  readonly purpose: string | "unknown";
  readonly utilityEvidenceClass: UtilityEvidenceClass;
  readonly utilityConfidence: OrdinalValue;
  readonly providerEvidence: string | "unknown";
  readonly priorSuccessfulExecutionEvidence: boolean;
  readonly priorDeliveredUtilityEvidence: boolean;
  readonly riskFlags: readonly string[];
  readonly diversityValue: OrdinalValue;
  readonly testValue: OrdinalValue;
  readonly knownAlternatives: readonly string[];
  readonly cost_rank_key: string;
  readonly assessed_at: string;
}

export function classifyUtilityEvidenceClass(input: {
  readonly candidate: PaymentCandidateV1;
  readonly priorSuccessfulExecutionEvidence?: boolean;
  readonly priorDeliveredUtilityEvidence?: boolean;
}): UtilityEvidenceClass {
  if (input.priorDeliveredUtilityEvidence) {
    return "OBSERVED_UTILITY";
  }
  if (input.priorSuccessfulExecutionEvidence) {
    return "INFERRED_UTILITY";
  }
  const purpose = input.candidate.expected_utility.purpose;
  const evidence = input.candidate.expected_utility.evidence;
  if (
    purpose === "unknown" ||
    purpose === "" ||
    input.candidate.expected_utility.utility_confidence === "none"
  ) {
    return "UNKNOWN_UTILITY";
  }
  if (
    typeof evidence === "string" &&
    evidence !== "unknown" &&
    /prior_|observed_|delivered_/i.test(evidence)
  ) {
    return "INFERRED_UTILITY";
  }
  return "ADVERTISED_UTILITY";
}

export function assessEconomicV2(
  candidate: PaymentCandidateV1,
  verdict: CandidatePolicyVerdict,
  options?: {
    readonly now?: Date;
    readonly priceMovementEvidence?: PriceMovementEvidence | null;
    readonly priorSuccessfulExecutionEvidence?: boolean;
    readonly priorDeliveredUtilityEvidence?: boolean;
    readonly knownAlternatives?: readonly string[];
    readonly diversityValue?: OrdinalValue;
    readonly testValue?: OrdinalValue;
    readonly providerEvidence?: string;
    readonly utilityConfidenceOverride?: OrdinalValue;
  },
): CandidateEconomicAssessmentV2 {
  const now = options?.now ?? new Date();
  const riskFlags: string[] = [];
  if (verdict.verdict !== "ELIGIBLE") {
    riskFlags.push(`policy_${verdict.verdict.toLowerCase()}`);
  }
  for (const r of verdict.reasons) {
    if (
      r.includes("blocklist") ||
      r.includes("stale") ||
      r.includes("cap") ||
      r.includes("malformed")
    ) {
      riskFlags.push(r);
    }
  }
  if (!candidate.execution_selected_candidate) {
    riskFlags.push("missing_productive_handoff");
  }

  const priorSuccessful =
    options?.priorSuccessfulExecutionEvidence ??
    (candidate.endpoint.includes("api.onesource.io") &&
      candidate.endpoint.includes("block-number"));
  const priorDelivered = options?.priorDeliveredUtilityEvidence ?? false;

  const utilityEvidenceClass = classifyUtilityEvidenceClass({
    candidate,
    priorSuccessfulExecutionEvidence: priorSuccessful,
    priorDeliveredUtilityEvidence: priorDelivered,
  });

  let utilityConfidence: OrdinalValue =
    options?.utilityConfidenceOverride ??
    candidate.expected_utility.utility_confidence;
  if (priorDelivered && utilityConfidence === "none") {
    utilityConfidence = "medium";
  } else if (priorSuccessful && (utilityConfidence === "none" || utilityConfidence === "low")) {
    utilityConfidence = "medium";
  }

  const currentCost =
    typeof candidate.amount_atomic === "string" ? candidate.amount_atomic : "unknown";
  const cost_rank_key =
    currentCost === "unknown" ? "zzzz_unknown" : currentCost.padStart(32, "0");

  let priceObservationAgeMs: number | null = null;
  try {
    const observed = Date.parse(candidate.freshness.observed_at);
    if (!Number.isNaN(observed)) {
      priceObservationAgeMs = Math.max(0, now.getTime() - observed);
    }
  } catch {
    priceObservationAgeMs = null;
  }

  return {
    schema_version: "trustforge_candidate_economic_assessment.v2",
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    currentCost,
    costAsset: typeof candidate.asset === "string" ? candidate.asset : "unknown",
    priceObservationAgeMs,
    priceMovementEvidence: options?.priceMovementEvidence ?? null,
    purpose: candidate.expected_utility.purpose,
    utilityEvidenceClass,
    utilityConfidence,
    providerEvidence:
      options?.providerEvidence ??
      (typeof candidate.provider_id === "string" ? candidate.provider_id : "unknown"),
    priorSuccessfulExecutionEvidence: priorSuccessful,
    priorDeliveredUtilityEvidence: priorDelivered,
    riskFlags,
    diversityValue: options?.diversityValue ?? "none",
    testValue: options?.testValue ?? "low",
    knownAlternatives: options?.knownAlternatives ?? [],
    cost_rank_key,
    assessed_at: now.toISOString(),
  };
}

export function economicAssessmentV2Sha256(
  assessment: CandidateEconomicAssessmentV2,
): string {
  return canonicalJsonSha256(assessment);
}
