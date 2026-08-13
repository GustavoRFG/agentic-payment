/**
 * b6-decision-policy-v1 — transparent deterministic BUY / DEFER / DONT_BUY policy.
 * BUY never authorizes payment.
 */

import { GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION } from "./b6-execution-gates";
import {
  buildCandidateDecisionSet,
  type CandidateDecisionEntry,
  type CandidateDecisionSet,
  type CandidateDisposition,
} from "./candidate-decision-set";
import type { CandidateEconomicAssessmentV2 } from "./economic-assessment-v2";
import {
  buildPaymentSelectionDecision,
  type EvidenceSufficiency,
  type PaymentSelectionDecisionV1,
  type SelectionRationaleItem,
} from "./payment-selection-decision-v1";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const B6_DECISION_POLICY_ID = "trustforge_b6_decision_policy" as const;
export const B6_DECISION_POLICY_VERSION = 1 as const;
export const DEFAULT_SELECTION_TTL_MS = 1_800_000;

export interface B6DecisionPolicyV1 {
  readonly id: typeof B6_DECISION_POLICY_ID;
  readonly version: typeof B6_DECISION_POLICY_VERSION;
  readonly payment_authorization: false;
  readonly selection_ttl_ms: number;
  readonly cheap_max_atomic: string;
  readonly price_rise_defer_bps: number;
  readonly notes: readonly string[];
}

export const B6_DECISION_POLICY_V1: B6DecisionPolicyV1 = {
  id: B6_DECISION_POLICY_ID,
  version: B6_DECISION_POLICY_VERSION,
  payment_authorization: false,
  selection_ttl_ms: DEFAULT_SELECTION_TTL_MS,
  cheap_max_atomic: "5000",
  price_rise_defer_bps: 500,
  notes: [
    "Deterministic transparent policy — not ML/LLM judgment",
    "BUY != PAYMENT_AUTHORIZED",
    "Incomplete utility leans DEFER, not DONT_BUY",
  ],
};

export function b6DecisionPolicyHash(
  policy: B6DecisionPolicyV1 = B6_DECISION_POLICY_V1,
): string {
  return canonicalJsonSha256(policy);
}

function confidenceRank(c: CandidateEconomicAssessmentV2["utilityConfidence"]): number {
  switch (c) {
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

function utilityClassRank(
  c: CandidateEconomicAssessmentV2["utilityEvidenceClass"],
): number {
  switch (c) {
    case "OBSERVED_UTILITY":
      return 0;
    case "INFERRED_UTILITY":
      return 1;
    case "ADVERTISED_UTILITY":
      return 2;
    default:
      return 3;
  }
}

function isIncompleteUtility(a: CandidateEconomicAssessmentV2): boolean {
  return (
    a.utilityEvidenceClass === "UNKNOWN_UTILITY" ||
    a.utilityConfidence === "none" ||
    (a.utilityEvidenceClass === "ADVERTISED_UTILITY" &&
      (a.utilityConfidence === "none" || a.utilityConfidence === "low") &&
      !a.priorSuccessfulExecutionEvidence &&
      !a.priorDeliveredUtilityEvidence)
  );
}

function isBuyableUtility(a: CandidateEconomicAssessmentV2): boolean {
  if (a.utilityEvidenceClass === "OBSERVED_UTILITY") return true;
  if (a.utilityConfidence === "medium" || a.utilityConfidence === "high") return true;
  if (
    a.utilityEvidenceClass === "INFERRED_UTILITY" &&
    (a.utilityConfidence === "medium" || a.utilityConfidence === "high")
  ) {
    return true;
  }
  return false;
}

function isCheap(cost: string | "unknown", maxAtomic: string): boolean {
  if (cost === "unknown") return false;
  try {
    return BigInt(cost) > 0n && BigInt(cost) <= BigInt(maxAtomic);
  } catch {
    return false;
  }
}

function riskWorse(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length > b.length;
}

function assessPriceDefer(
  a: CandidateEconomicAssessmentV2,
  policy: B6DecisionPolicyV1,
): SelectionRationaleItem | null {
  const pm = a.priceMovementEvidence;
  if (!pm) return null;
  if (pm.price_direction !== "up") return null;
  if (pm.relative_delta_bps == null) return null;
  if (pm.relative_delta_bps <= policy.price_rise_defer_bps) return null;
  if (a.utilityEvidenceClass === "OBSERVED_UTILITY") return null;
  return {
    code: "PRICE_TOO_HIGH_RELATIVE_TO_RECENT_OBSERVATION",
    detail: `relative_delta_bps=${pm.relative_delta_bps} > ${policy.price_rise_defer_bps}; utility=${a.utilityEvidenceClass}`,
  };
}

function dominates(
  a: CandidateDecisionEntry,
  aAssess: CandidateEconomicAssessmentV2,
  b: CandidateDecisionEntry,
  bAssess: CandidateEconomicAssessmentV2,
): boolean {
  if (aAssess.purpose !== bAssess.purpose) return false;
  if (a.utilityEvidenceClass !== b.utilityEvidenceClass) return false;
  if (a.costAtomic === "unknown" || b.costAtomic === "unknown") return false;
  try {
    if (BigInt(a.costAtomic) >= BigInt(b.costAtomic)) return false;
  } catch {
    return false;
  }
  if (riskWorse(a.riskFlags, b.riskFlags)) return false;
  return true;
}

export function decideB6(input: {
  readonly set: CandidateDecisionSet;
  readonly assessments: readonly CandidateEconomicAssessmentV2[];
  readonly now: Date;
  readonly selectionTtlMs?: number;
  readonly policy?: B6DecisionPolicyV1;
}): PaymentSelectionDecisionV1 {
  void GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION;
  const policy = input.policy ?? B6_DECISION_POLICY_V1;
  if (policy.payment_authorization !== false) {
    throw new Error(`${GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION}: policy must not authorize`);
  }
  const ttl = input.selectionTtlMs ?? policy.selection_ttl_ms ?? DEFAULT_SELECTION_TTL_MS;
  const createdAt = input.now.toISOString();
  const expiresAt = new Date(input.now.getTime() + ttl).toISOString();
  const policyHash = b6DecisionPolicyHash(policy);

  const assessById = new Map(input.assessments.map((a) => [a.candidate_id, a]));

  type Working = {
    entry: CandidateDecisionEntry;
    assess: CandidateEconomicAssessmentV2;
    deferReason: SelectionRationaleItem | null;
    incomplete: boolean;
    buyable: boolean;
  };

  const working: Working[] = input.set.candidates.map((entry) => {
    const assess = assessById.get(entry.candidateId);
    if (!assess) {
      throw new Error(
        `BLOCKED_B6_MISSING_ASSESSMENT: no assessment for ${entry.candidateId}`,
      );
    }
    return {
      entry,
      assess,
      deferReason: null as SelectionRationaleItem | null,
      incomplete: isIncompleteUtility(assess),
      buyable: false,
    };
  });

  const dispositionUpdates = new Map<
    string,
    { disposition: CandidateDisposition; reason: string }
  >();

  for (const w of working) {
    if (w.entry.eligibility === "UNSUPPORTED") {
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "UNSUPPORTED",
        reason: "UNSUPPORTED_PROTOCOL",
      });
      continue;
    }
    if (
      w.entry.eligibility === "INELIGIBLE" ||
      w.entry.eligibility === "STALE"
    ) {
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "INELIGIBLE",
        reason:
          w.entry.eligibility === "STALE" ? "POLICY_STALE" : "POLICY_INELIGIBLE",
      });
      continue;
    }
    if (w.entry.eligibility !== "ELIGIBLE" && w.entry.eligibility !== "REQUIRES_REVIEW") {
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "INELIGIBLE",
        reason: "POLICY_INELIGIBLE",
      });
      continue;
    }

    const priceDefer = assessPriceDefer(w.assess, policy);
    if (priceDefer) {
      w.deferReason = priceDefer;
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "DEFERRED",
        reason: priceDefer.code,
      });
      continue;
    }

    if (w.incomplete && isCheap(w.entry.costAtomic, policy.cheap_max_atomic)) {
      w.deferReason = {
        code: "UTILITY_EVIDENCE_INCOMPLETE",
        detail: `utilityEvidenceClass=${w.assess.utilityEvidenceClass} confidence=${w.assess.utilityConfidence}`,
      };
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "DEFERRED",
        reason: "UTILITY_EVIDENCE_INCOMPLETE",
      });
      continue;
    }

    if (isBuyableUtility(w.assess)) {
      w.buyable = true;
      continue;
    }

    if (w.incomplete) {
      w.deferReason = {
        code: "UTILITY_EVIDENCE_INCOMPLETE",
        detail: `utilityEvidenceClass=${w.assess.utilityEvidenceClass} confidence=${w.assess.utilityConfidence}`,
      };
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "DEFERRED",
        reason: "UTILITY_EVIDENCE_INCOMPLETE",
      });
      continue;
    }

    dispositionUpdates.set(w.entry.candidateId, {
      disposition: "INELIGIBLE",
      reason: "UTILITY_NOT_JUSTIFIED",
    });
  }

  const buyable = working.filter(
    (w) => w.buyable && !dispositionUpdates.has(w.entry.candidateId),
  );

  // Dominance: same purpose + utility class, cheaper, no worse risk.
  for (const a of buyable) {
    for (const b of buyable) {
      if (a.entry.candidateId === b.entry.candidateId) continue;
      if (dominates(a.entry, a.assess, b.entry, b.assess)) {
        if (!dispositionUpdates.has(b.entry.candidateId)) {
          dispositionUpdates.set(b.entry.candidateId, {
            disposition: "NOT_SELECTED",
            reason: `DOMINATED_BY_ALTERNATIVE:${a.entry.candidateId}`,
          });
          b.buyable = false;
        }
      }
    }
  }

  const remainingBuyable = buyable.filter(
    (w) => !dispositionUpdates.has(w.entry.candidateId) && w.buyable,
  );

  remainingBuyable.sort((a, b) => {
    const uc =
      utilityClassRank(a.assess.utilityEvidenceClass) -
      utilityClassRank(b.assess.utilityEvidenceClass);
    if (uc !== 0) return uc;
    const conf =
      confidenceRank(a.assess.utilityConfidence) -
      confidenceRank(b.assess.utilityConfidence);
    if (conf !== 0) return conf;
    if (a.assess.cost_rank_key < b.assess.cost_rank_key) return -1;
    if (a.assess.cost_rank_key > b.assess.cost_rank_key) return 1;
    return a.entry.candidateId.localeCompare(b.entry.candidateId);
  });

  const rationale: SelectionRationaleItem[] = [];
  let decision: PaymentSelectionDecisionV1["decision"] = "DONT_BUY";
  let selectedCandidateId: string | null = null;
  let selectedObservationId: string | null = null;
  let evidenceSufficiency: EvidenceSufficiency = "insufficient";
  let deferralConditions: SelectionRationaleItem[] | undefined;
  let rejectionReasons: SelectionRationaleItem[] | undefined;

  const deferred = working.filter(
    (w) => dispositionUpdates.get(w.entry.candidateId)?.disposition === "DEFERRED",
  );
  const policyEligible = working.filter(
    (w) =>
      w.entry.eligibility === "ELIGIBLE" ||
      w.entry.eligibility === "REQUIRES_REVIEW",
  );

  if (remainingBuyable.length > 0) {
    const winner = remainingBuyable[0]!;
    decision = "BUY";
    selectedCandidateId = winner.entry.candidateId;
    selectedObservationId = winner.entry.observationId;
    evidenceSufficiency = "sufficient";
    dispositionUpdates.set(winner.entry.candidateId, {
      disposition: "SELECTED",
      reason: "SELECTED_BEST_BUYABLE",
    });
    for (const other of remainingBuyable.slice(1)) {
      dispositionUpdates.set(other.entry.candidateId, {
        disposition: "NOT_SELECTED",
        reason: "not_selected_higher_cost_or_lower_utility",
      });
    }
    rationale.push({
      code: "BUY_SELECTED",
      detail: `selected=${winner.entry.candidateId} cost=${winner.entry.costAtomic} utility=${winner.assess.utilityEvidenceClass}/${winner.assess.utilityConfidence}`,
    });
    rationale.push({
      code: "RANKING_RULE",
      detail:
        "utility_class then confidence then lowest_cost then candidate_id; dominance applied",
    });
  } else if (deferred.length > 0 || (policyEligible.length > 0 && policyEligible.every((w) => w.incomplete || w.deferReason))) {
    decision = "DEFER";
    evidenceSufficiency = "partial";
    deferralConditions = deferred.map(
      (w) =>
        w.deferReason ?? {
          code: "UTILITY_EVIDENCE_INCOMPLETE",
          detail: w.entry.candidateId,
        },
    );
    if (deferralConditions.length === 0) {
      deferralConditions = [
        {
          code: "UTILITY_EVIDENCE_INCOMPLETE",
          detail: "eligible candidates lack buyable utility evidence",
        },
      ];
    }
    rationale.push({
      code: "DEFER",
      detail: `deferred_count=${deferred.length || policyEligible.length}`,
    });
    for (const d of deferralConditions) {
      rationale.push(d);
    }
  } else {
    decision = "DONT_BUY";
    evidenceSufficiency = "insufficient";
    rejectionReasons = working.map((w) => ({
      code: dispositionUpdates.get(w.entry.candidateId)?.reason ?? "POLICY_INELIGIBLE",
      detail: `candidate=${w.entry.candidateId} eligibility=${w.entry.eligibility}`,
    }));
    rationale.push({
      code: "DONT_BUY",
      detail: "no eligible buyable or deferrable candidates",
    });
    for (const r of rejectionReasons.slice(0, 8)) {
      rationale.push(r);
    }
  }

  const evaluatedCandidates = input.set.candidates.map((c) => {
    const u = dispositionUpdates.get(c.candidateId);
    if (!u) {
      return {
        ...c,
        disposition: "NOT_SELECTED" as const,
        reason: "not_selected",
      };
    }
    return { ...c, disposition: u.disposition, reason: u.reason };
  });

  // Preserve set identity hashes from input set (frozen alternatives).
  return buildPaymentSelectionDecision({
    createdAt,
    candidateSetHash: input.set.candidateSetHash,
    candidateObservationSetHash: input.set.candidateObservationSetHash,
    decisionPolicyId: policy.id,
    decisionPolicyVersion: policy.version,
    decisionPolicyHash: policyHash,
    evaluatedCandidates,
    decision,
    selectedCandidateId,
    selectedObservationId,
    selectionRationale: rationale,
    evidenceSufficiency,
    deferralConditions,
    rejectionReasons,
    expiresAt,
  });
}

/** Rebuild a decision set with dispositions from a decision. */
export function candidateSetFromDecision(
  decision: PaymentSelectionDecisionV1,
): CandidateDecisionSet {
  return buildCandidateDecisionSet(decision.evaluatedCandidates);
}
