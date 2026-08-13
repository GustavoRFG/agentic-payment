/**
 * payment-candidate-selection — deterministic selection among eligible candidates.
 * Selection != human authorization.
 */

import {
  B5_SELECTION_SCHEMA,
  BLOCKED_B5_NO_ELIGIBLE_CANDIDATE,
  GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED,
} from "./b5-execution-gates";
import {
  assessPaymentCandidateEconomics,
  economicAssessmentSha256,
  type CandidateEconomicAssessment,
} from "./payment-candidate-economics";
import {
  evaluatePaymentCandidatePolicy,
  policyVerdictSha256,
  type CandidatePolicyVerdict,
  type B5CandidatePolicyConfig,
} from "./payment-candidate-policy";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";
import { paymentCandidateSha256 } from "./payment-candidate-v1";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const B5_SELECTION_RULE_V1 =
  "productive_core_compatible_then_utility_then_lowest_cost_then_candidate_id" as const;

export interface PaymentCandidateSelection {
  readonly schema_version: typeof B5_SELECTION_SCHEMA;
  readonly selection_id: string;
  readonly selected_candidate_id: string;
  readonly selected_observation_id: string;
  readonly selected_candidate_sha256: string;
  readonly candidate_set_sha256: string;
  readonly policy_verdict_hashes: readonly string[];
  readonly economic_assessment_hashes: readonly string[];
  readonly ranking_rule: typeof B5_SELECTION_RULE_V1;
  readonly selection_rationale: readonly string[];
  readonly rejected: readonly {
    readonly candidate_id: string;
    readonly observation_id: string;
    readonly reason: string;
  }[];
  readonly selected_at: string;
  readonly human_authorized: false;
  readonly payment_authorized: false;
  readonly selected_candidate: PaymentCandidateV1;
  readonly selected_policy_verdict: CandidatePolicyVerdict;
  readonly selected_economic_assessment: CandidateEconomicAssessment;
}

function utilityRank(confidence: CandidateEconomicAssessment["utility_confidence"]): number {
  switch (confidence) {
    case "high":
      return 0;
    case "medium":
      return 1;
    case "low":
      return 2;
    default:
      return 3;
  }
}

export function selectPaymentCandidate(
  candidates: readonly PaymentCandidateV1[],
  options?: {
    readonly policy?: B5CandidatePolicyConfig;
    readonly now?: Date;
  },
): PaymentCandidateSelection {
  void GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED;
  const now = options?.now ?? new Date();
  const evaluated = candidates.map((c) => {
    const verdict = evaluatePaymentCandidatePolicy(c, {
      policy: options?.policy,
      now,
    });
    const economics = assessPaymentCandidateEconomics(c, verdict, { now });
    return { candidate: c, verdict, economics };
  });

  const eligible = evaluated.filter((e) => e.verdict.verdict === "ELIGIBLE");
  const rejected = evaluated
    .filter((e) => e.verdict.verdict !== "ELIGIBLE")
    .map((e) => ({
      candidate_id: e.candidate.candidate_id,
      observation_id: e.candidate.observation_id,
      reason: `${e.verdict.verdict}:${e.verdict.reasons.join(",")}`,
    }));

  if (eligible.length === 0) {
    throw new Error(
      `${BLOCKED_B5_NO_ELIGIBLE_CANDIDATE}: no ELIGIBLE candidates after policy`,
    );
  }

  // Prefer productive-core handoff, then utility, then lowest cost, then candidate_id.
  const ranked = [...eligible].sort((a, b) => {
    const aHand = a.candidate.execution_selected_candidate ? 0 : 1;
    const bHand = b.candidate.execution_selected_candidate ? 0 : 1;
    if (aHand !== bHand) return aHand - bHand;
    const u = utilityRank(a.economics.utility_confidence) -
      utilityRank(b.economics.utility_confidence);
    if (u !== 0) return u;
    if (a.economics.cost_rank_key < b.economics.cost_rank_key) return -1;
    if (a.economics.cost_rank_key > b.economics.cost_rank_key) return 1;
    return a.candidate.candidate_id.localeCompare(b.candidate.candidate_id);
  });

  // Among equal top cost+utility+handoff, keep lowest cost only — already sorted.
  const winner = ranked[0]!;
  const notSelectedEligible = ranked.slice(1).map((e) => ({
    candidate_id: e.candidate.candidate_id,
    observation_id: e.candidate.observation_id,
    reason: "not_selected_higher_cost_or_lower_utility_or_later_id",
  }));

  const rationale = [
    `ranking_rule=${B5_SELECTION_RULE_V1}`,
    `selected_candidate_id=${winner.candidate.candidate_id}`,
    `cost_atomic=${winner.economics.cost_atomic}`,
    `utility_confidence=${winner.economics.utility_confidence}`,
    `productive_handoff=${Boolean(winner.candidate.execution_selected_candidate)}`,
    `eligible_count=${eligible.length}`,
    `rejected_count=${rejected.length}`,
  ];

  const candidate_set_sha256 = canonicalJsonSha256(
    candidates.map((c) => c.candidate_id).sort(),
  );
  const selection_id = canonicalJsonSha256({
    candidate_set_sha256,
    selected: winner.candidate.candidate_id,
    observation: winner.candidate.observation_id,
    rule: B5_SELECTION_RULE_V1,
    at: now.toISOString(),
  }).slice(0, 32);

  return {
    schema_version: B5_SELECTION_SCHEMA,
    selection_id,
    selected_candidate_id: winner.candidate.candidate_id,
    selected_observation_id: winner.candidate.observation_id,
    selected_candidate_sha256: paymentCandidateSha256(winner.candidate),
    candidate_set_sha256,
    policy_verdict_hashes: evaluated.map((e) => policyVerdictSha256(e.verdict)),
    economic_assessment_hashes: evaluated.map((e) =>
      economicAssessmentSha256(e.economics),
    ),
    ranking_rule: B5_SELECTION_RULE_V1,
    selection_rationale: rationale,
    rejected: [...rejected, ...notSelectedEligible],
    selected_at: now.toISOString(),
    human_authorized: false,
    payment_authorized: false,
    selected_candidate: winner.candidate,
    selected_policy_verdict: winner.verdict,
    selected_economic_assessment: winner.economics,
  };
}

export function selectionArtifactSha256(
  selection: PaymentCandidateSelection,
): string {
  const {
    selected_candidate: _c,
    selected_policy_verdict: _v,
    selected_economic_assessment: _e,
    ...rest
  } = selection;
  return canonicalJsonSha256(rest);
}
