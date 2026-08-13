/**
 * payment-candidate-economics — minimal "should we consider paying?" assessment.
 * Does not fabricate ROI. Not payment authority.
 */

import type { CandidatePolicyVerdict } from "./payment-candidate-policy";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export interface CandidateEconomicAssessment {
  readonly schema_version: "trustforge_candidate_economic_assessment.v1";
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly cost_atomic: string | "unknown";
  readonly cost_asset: string | "unknown";
  readonly expected_purpose: string | "unknown";
  readonly expected_utility_evidence: string | "unknown";
  readonly utility_confidence: "none" | "low" | "medium" | "high";
  readonly known_alternatives: readonly string[];
  /** Lower is cheaper / preferred when other factors equal. */
  readonly cost_rank_key: string;
  readonly risk_flags: readonly string[];
  readonly notes: readonly string[];
  readonly assessed_at: string;
}

export function assessPaymentCandidateEconomics(
  candidate: PaymentCandidateV1,
  verdict: CandidatePolicyVerdict,
  options?: {
    readonly now?: Date;
    readonly knownAlternatives?: readonly string[];
  },
): CandidateEconomicAssessment {
  const now = options?.now ?? new Date();
  const risk_flags: string[] = [];
  if (verdict.verdict !== "ELIGIBLE") {
    risk_flags.push(`policy_${verdict.verdict.toLowerCase()}`);
  }
  for (const r of verdict.reasons) {
    if (r.includes("blocklist") || r.includes("stale") || r.includes("cap")) {
      risk_flags.push(r);
    }
  }
  if (!candidate.execution_selected_candidate) {
    risk_flags.push("missing_productive_handoff");
  }
  const cost_atomic =
    typeof candidate.amount_atomic === "string" ? candidate.amount_atomic : "unknown";
  const cost_rank_key =
    cost_atomic === "unknown"
      ? "zzzz_unknown"
      : cost_atomic.padStart(32, "0");

  let utility_confidence = candidate.expected_utility.utility_confidence;
  let expected_utility_evidence = candidate.expected_utility.evidence;
  // Known real-history boost for previously proven OneSource path — confidence only.
  if (
    candidate.endpoint.includes("api.onesource.io") &&
    candidate.endpoint.includes("block-number")
  ) {
    utility_confidence = "medium";
    expected_utility_evidence =
      "prior_trustforge_mainnet_payment_history_onesource_block_number";
  }

  return {
    schema_version: "trustforge_candidate_economic_assessment.v1",
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    cost_atomic,
    cost_asset: typeof candidate.asset === "string" ? candidate.asset : "unknown",
    expected_purpose: candidate.expected_utility.purpose,
    expected_utility_evidence,
    utility_confidence,
    known_alternatives: options?.knownAlternatives ?? [],
    cost_rank_key,
    risk_flags,
    notes: [
      "Economic assessment is consideration-only; not payment authorization",
      "Utility is not ROI; unknown utility is explicit when evidence is absent",
    ],
    assessed_at: now.toISOString(),
  };
}

export function economicAssessmentSha256(
  assessment: CandidateEconomicAssessment,
): string {
  return canonicalJsonSha256(assessment);
}
