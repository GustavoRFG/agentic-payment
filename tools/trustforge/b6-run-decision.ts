/**
 * b6-run-decision — orchestrate CandidateDecisionSet + PaymentSelectionDecisionV1.
 * Zero execution authority.
 */

import { assertB6HasNoExecutionAuthority } from "./b6-execution-gates";
import {
  buildCandidateDecisionSet,
  type CandidateDecisionSet,
} from "./candidate-decision-set";
import {
  decideB6,
  type B6DecisionPolicyV1,
} from "./b6-decision-policy-v1";
import {
  economicAssessmentV2Sha256,
  type CandidateEconomicAssessmentV2,
} from "./economic-assessment-v2";
import type { CandidatePolicyVerdict } from "./payment-candidate-policy";
import { policyVerdictSha256 } from "./payment-candidate-policy";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";
import { paymentCandidateSha256 } from "./payment-candidate-v1";
import type { PaymentSelectionDecisionV1 } from "./payment-selection-decision-v1";

export interface B6DecisionInputRow {
  readonly candidate: PaymentCandidateV1;
  readonly verdict: CandidatePolicyVerdict;
  readonly economicsV2: CandidateEconomicAssessmentV2;
}

export interface B6DecisionRunResult {
  readonly decision: PaymentSelectionDecisionV1;
  readonly set: CandidateDecisionSet;
  readonly payment_authorized: false;
}

export function runB6DecisionFromCandidates(
  rows: readonly B6DecisionInputRow[],
  options?: {
    readonly now?: Date;
    readonly selectionTtlMs?: number;
    readonly policy?: B6DecisionPolicyV1;
  },
): B6DecisionRunResult {
  assertB6HasNoExecutionAuthority();
  const now = options?.now ?? new Date();

  const provisional = buildCandidateDecisionSet(
    rows.map((row) => ({
      candidateId: row.candidate.candidate_id,
      observationId: row.candidate.observation_id,
      eligibility: row.verdict.verdict,
      costAtomic:
        typeof row.candidate.amount_atomic === "string"
          ? row.candidate.amount_atomic
          : "unknown",
      utilityEvidenceClass: row.economicsV2.utilityEvidenceClass,
      utilityConfidence: row.economicsV2.utilityConfidence,
      riskFlags: row.economicsV2.riskFlags,
      freshnessObservedAt: row.candidate.freshness.observed_at,
      rankingInputs: {
        cost_rank_key: row.economicsV2.cost_rank_key,
        utilityEvidenceClass: row.economicsV2.utilityEvidenceClass,
        utilityConfidence: row.economicsV2.utilityConfidence,
        purpose:
          typeof row.economicsV2.purpose === "string"
            ? row.economicsV2.purpose
            : "unknown",
        price_direction:
          row.economicsV2.priceMovementEvidence?.price_direction ?? null,
        relative_delta_bps:
          row.economicsV2.priceMovementEvidence?.relative_delta_bps ?? null,
      },
      disposition: "NOT_SELECTED",
      reason: "pending_b6_decision",
      purpose: row.economicsV2.purpose,
      candidateSha256: paymentCandidateSha256(row.candidate),
      policyVerdictSha256: policyVerdictSha256(row.verdict),
      economicAssessmentSha256: economicAssessmentV2Sha256(row.economicsV2),
    })),
  );

  const decision = decideB6({
    set: provisional,
    assessments: rows.map((r) => r.economicsV2),
    now,
    selectionTtlMs: options?.selectionTtlMs,
    policy: options?.policy,
  });

  const set = buildCandidateDecisionSet(decision.evaluatedCandidates);

  return {
    decision,
    set,
    payment_authorized: false,
  };
}

export { assertB6HasNoExecutionAuthority };
