/**
 * b61-run-decision — objective-bound B.6.1 selection.
 * OBJECTIVE → capability match → eligible relevant candidates → economics → BUY/DEFER/DONT_BUY
 * Zero execution authority. BUY != payment authorization.
 */

import {
  assertB61HasNoExecutionAuthority,
  GUARD_OBJECTIVE_MATCH_PRECEDES_ECONOMIC_RANKING,
  NEED_MORE_DISCOVERY,
  NO_RELEVANT_CANDIDATE,
  OBJECTIVE_BUDGET_EXCEEDED,
  OBJECTIVE_REQUIRED,
  OUT_OF_SCOPE_OBJECTIVE,
} from "./b61-execution-gates";
import {
  assessCapabilityMatch,
  isSufficientObjectiveMatch,
  type CapabilityMatchAssessment,
} from "./capability-match-assessment";
import {
  buildCandidateDecisionSet,
  type CandidateDecisionEntry,
  type CandidateDecisionSet,
  type CandidateDisposition,
  type ObjectiveDisposition,
} from "./candidate-decision-set";
import {
  B6_DECISION_POLICY_V1,
  b6DecisionPolicyHash,
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
import {
  assertObjectiveIntegrity,
  type PaymentDecisionObjectiveV1,
} from "./payment-decision-objective-v1";
import {
  buildPaymentSelectionDecision,
  type EvidenceSufficiency,
  type PaymentSelectionDecisionV1,
  type SelectionRationaleItem,
} from "./payment-selection-decision-v1";
import { GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION } from "./b6-execution-gates";

export interface B61DecisionInputRow {
  readonly candidate: PaymentCandidateV1;
  readonly verdict: CandidatePolicyVerdict;
  readonly economicsV2: CandidateEconomicAssessmentV2;
}

export interface B61DecisionRunResult {
  readonly objective: PaymentDecisionObjectiveV1;
  readonly decision: PaymentSelectionDecisionV1;
  readonly set: CandidateDecisionSet;
  readonly matches: ReadonlyMap<string, CapabilityMatchAssessment>;
  readonly payment_authorized: false;
}

const DEFAULT_SELECTION_TTL_MS = 1_800_000;

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

function exceedsBudget(
  cost: string | "unknown",
  maxBudget: string | null,
): boolean {
  if (maxBudget === null) return false;
  if (cost === "unknown") return false;
  try {
    return BigInt(cost) > BigInt(maxBudget);
  } catch {
    return false;
  }
}

function objectiveDispositionFromMatch(
  match: CapabilityMatchAssessment["match"],
): ObjectiveDisposition {
  switch (match) {
    case "EXACT":
    case "COMPATIBLE":
      return "IN_SCOPE";
    case "PARTIAL":
      return "OBJECTIVE_PARTIAL";
    case "UNKNOWN":
      return "OBJECTIVE_UNKNOWN";
    case "MISMATCH":
      return "OUT_OF_SCOPE_OBJECTIVE";
    default:
      return "OBJECTIVE_UNKNOWN";
  }
}

/**
 * Productive B.6.1 entry: objective is mandatory.
 */
export function runB61DecisionFromCandidates(
  rows: readonly B61DecisionInputRow[],
  objective: PaymentDecisionObjectiveV1 | null | undefined,
  options?: {
    readonly now?: Date;
    readonly selectionTtlMs?: number;
    readonly policy?: B6DecisionPolicyV1;
  },
): B61DecisionRunResult {
  assertB61HasNoExecutionAuthority();
  void GUARD_OBJECTIVE_MATCH_PRECEDES_ECONOMIC_RANKING;
  void GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION;

  if (!objective) {
    throw new Error(`${OBJECTIVE_REQUIRED}: productive B6.1 requires PaymentDecisionObjective`);
  }
  assertObjectiveIntegrity(objective);

  const now = options?.now ?? new Date();
  const policy = options?.policy ?? B6_DECISION_POLICY_V1;
  const ttl = options?.selectionTtlMs ?? policy.selection_ttl_ms ?? DEFAULT_SELECTION_TTL_MS;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + ttl).toISOString();
  const policyHash = b6DecisionPolicyHash(policy);

  const matches = new Map<string, CapabilityMatchAssessment>();
  for (const row of rows) {
    const m = assessCapabilityMatch({
      objective,
      candidate: row.candidate,
      economics: row.economicsV2,
    });
    matches.set(row.candidate.candidate_id, m);
  }

  const provisionalEntries: CandidateDecisionEntry[] = rows.map((row) => {
    const match = matches.get(row.candidate.candidate_id)!;
    const cost =
      typeof row.candidate.amount_atomic === "string"
        ? row.candidate.amount_atomic
        : "unknown";
    let objectiveDisposition = objectiveDispositionFromMatch(match.match);
    if (
      objectiveDisposition === "IN_SCOPE" &&
      exceedsBudget(cost, objective.maxBudget)
    ) {
      objectiveDisposition = "OBJECTIVE_BUDGET_EXCEEDED";
    }
    return {
      candidateId: row.candidate.candidate_id,
      observationId: row.candidate.observation_id,
      eligibility: row.verdict.verdict,
      costAtomic: cost,
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
        objective_match: match.match,
      },
      disposition: "NOT_SELECTED",
      reason: "pending_b61_decision",
      purpose: row.economicsV2.purpose,
      candidateSha256: paymentCandidateSha256(row.candidate),
      policyVerdictSha256: policyVerdictSha256(row.verdict),
      economicAssessmentSha256: economicAssessmentV2Sha256(row.economicsV2),
      capabilityMatchAssessmentHash: match.assessmentHash,
      objectiveDisposition,
    };
  });

  const provisional = buildCandidateDecisionSet(provisionalEntries);
  const assessById = new Map(rows.map((r) => [r.candidate.candidate_id, r.economicsV2]));

  type Working = {
    entry: CandidateDecisionEntry;
    assess: CandidateEconomicAssessmentV2;
    match: CapabilityMatchAssessment;
    deferReason: SelectionRationaleItem | null;
    incomplete: boolean;
    buyable: boolean;
  };

  const dispositionUpdates = new Map<
    string,
    { disposition: CandidateDisposition; reason: string }
  >();

  const working: Working[] = provisional.candidates.map((entry) => {
    const assess = assessById.get(entry.candidateId)!;
    const match = matches.get(entry.candidateId)!;
    return {
      entry,
      assess,
      match,
      deferReason: null as SelectionRationaleItem | null,
      incomplete: isIncompleteUtility(assess),
      buyable: false,
    };
  });

  // 1) Objective match precedes economic ranking
  for (const w of working) {
    if (w.entry.objectiveDisposition === "OUT_OF_SCOPE_OBJECTIVE") {
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "OUT_OF_SCOPE_OBJECTIVE",
        reason: OUT_OF_SCOPE_OBJECTIVE,
      });
      continue;
    }
    if (w.entry.objectiveDisposition === "OBJECTIVE_BUDGET_EXCEEDED") {
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "INELIGIBLE",
        reason: OBJECTIVE_BUDGET_EXCEEDED,
      });
      continue;
    }
    if (w.entry.objectiveDisposition === "OBJECTIVE_UNKNOWN") {
      w.deferReason = {
        code: "OBJECTIVE_CAPABILITY_UNKNOWN",
        detail: w.match.rationale,
      };
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "DEFERRED",
        reason: "OBJECTIVE_CAPABILITY_UNKNOWN",
      });
      continue;
    }
    if (w.entry.objectiveDisposition === "OBJECTIVE_PARTIAL") {
      w.deferReason = {
        code: "OBJECTIVE_CAPABILITY_PARTIAL",
        detail: w.match.rationale,
      };
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "DEFERRED",
        reason: "OBJECTIVE_CAPABILITY_PARTIAL",
      });
      continue;
    }
    if (!isSufficientObjectiveMatch(w.match.match)) {
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "OUT_OF_SCOPE_OBJECTIVE",
        reason: OUT_OF_SCOPE_OBJECTIVE,
      });
      continue;
    }

    // 2) Policy eligibility (only for in-scope)
    if (w.entry.eligibility === "UNSUPPORTED") {
      dispositionUpdates.set(w.entry.candidateId, {
        disposition: "UNSUPPORTED",
        reason: "UNSUPPORTED_PROTOCOL",
      });
      continue;
    }
    if (w.entry.eligibility === "INELIGIBLE" || w.entry.eligibility === "STALE") {
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

    if (w.incomplete && isCheap(w.entry.costAtomic, policy.cheap_max_atomic)) {
      w.deferReason = {
        code: "UTILITY_EVIDENCE_INCOMPLETE",
        detail: `utilityEvidenceClass=${w.assess.utilityEvidenceClass}`,
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
        detail: `utilityEvidenceClass=${w.assess.utilityEvidenceClass}`,
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

  buyable.sort((a, b) => {
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
  let decisionKind: PaymentSelectionDecisionV1["decision"] = "DONT_BUY";
  let selectedCandidateId: string | null = null;
  let selectedObservationId: string | null = null;
  let evidenceSufficiency: EvidenceSufficiency = "insufficient";
  let deferralConditions: SelectionRationaleItem[] | undefined;
  let rejectionReasons: SelectionRationaleItem[] | undefined;

  const inScopeBuyablePool = working.filter(
    (w) => w.entry.objectiveDisposition === "IN_SCOPE",
  );
  const deferred = working.filter(
    (w) => dispositionUpdates.get(w.entry.candidateId)?.disposition === "DEFERRED",
  );
  const outOfScope = working.filter(
    (w) =>
      dispositionUpdates.get(w.entry.candidateId)?.disposition ===
      "OUT_OF_SCOPE_OBJECTIVE",
  );
  const budgetExceeded = working.filter(
    (w) => w.entry.objectiveDisposition === "OBJECTIVE_BUDGET_EXCEEDED",
  );
  const objectiveRelevant = working.filter(
    (w) =>
      w.entry.objectiveDisposition === "IN_SCOPE" ||
      w.entry.objectiveDisposition === "OBJECTIVE_BUDGET_EXCEEDED" ||
      w.entry.objectiveDisposition === "OBJECTIVE_PARTIAL" ||
      w.entry.objectiveDisposition === "OBJECTIVE_UNKNOWN",
  );

  if (buyable.length > 0) {
    const winner = buyable[0]!;
    decisionKind = "BUY";
    selectedCandidateId = winner.entry.candidateId;
    selectedObservationId = winner.entry.observationId;
    evidenceSufficiency = "sufficient";
    dispositionUpdates.set(winner.entry.candidateId, {
      disposition: "SELECTED",
      reason: "SELECTED_BEST_OBJECTIVE_MATCH",
    });
    for (const other of buyable.slice(1)) {
      dispositionUpdates.set(other.entry.candidateId, {
        disposition: "NOT_SELECTED",
        reason: "not_selected_higher_cost_or_lower_utility",
      });
    }
    rationale.push({
      code: "BUY_SELECTED_FOR_OBJECTIVE",
      detail: `objective=${objective.requestedCapability} selected=${winner.entry.candidateId} match=${winner.match.match} cost=${winner.entry.costAtomic}`,
    });
    rationale.push({
      code: "OBJECTIVE_MATCH_PRECEDES_PRICE",
      detail: GUARD_OBJECTIVE_MATCH_PRECEDES_ECONOMIC_RANKING,
    });
  } else if (objectiveRelevant.length === 0) {
    decisionKind = "DEFER";
    evidenceSufficiency = "insufficient";
    deferralConditions = [
      {
        code: NEED_MORE_DISCOVERY,
        detail: `${NO_RELEVANT_CANDIDATE}: no candidate satisfies ${objective.requestedCapability}`,
      },
    ];
    rationale.push({
      code: NO_RELEVANT_CANDIDATE,
      detail: `requestedCapability=${objective.requestedCapability}; out_of_scope=${outOfScope.length}`,
    });
  } else if (
    budgetExceeded.length > 0 &&
    inScopeBuyablePool.length === 0 &&
    deferred.length === 0
  ) {
    decisionKind = "DONT_BUY";
    evidenceSufficiency = "insufficient";
    rejectionReasons = budgetExceeded.map((w) => ({
      code: OBJECTIVE_BUDGET_EXCEEDED,
      detail: `candidate=${w.entry.candidateId} cost=${w.entry.costAtomic} maxBudget=${objective.maxBudget}`,
    }));
    rationale.push({
      code: "DONT_BUY",
      detail: "all objective-compatible candidates exceed objective maxBudget",
    });
  } else if (deferred.length > 0 || inScopeBuyablePool.some((w) => w.incomplete)) {
    decisionKind = "DEFER";
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
          code: NEED_MORE_DISCOVERY,
          detail: "in-scope candidates lack sufficient evidence",
        },
      ];
    }
    rationale.push({
      code: "DEFER",
      detail: `deferred_count=${deferred.length}; in_scope=${inScopeBuyablePool.length}`,
    });
  } else {
    decisionKind = "DONT_BUY";
    evidenceSufficiency = "insufficient";
    rejectionReasons = inScopeBuyablePool.map((w) => ({
      code: dispositionUpdates.get(w.entry.candidateId)?.reason ?? "POLICY_INELIGIBLE",
      detail: `candidate=${w.entry.candidateId}`,
    }));
    if (rejectionReasons.length === 0) {
      decisionKind = "DEFER";
      deferralConditions = [
        {
          code: NEED_MORE_DISCOVERY,
          detail: NO_RELEVANT_CANDIDATE,
        },
      ];
      rationale.push({
        code: NO_RELEVANT_CANDIDATE,
        detail: `requestedCapability=${objective.requestedCapability}`,
      });
    } else {
      rationale.push({
        code: "DONT_BUY",
        detail: "in-scope candidates affirmatively fail policy/utility gates",
      });
    }
  }

  const evaluatedCandidates = provisional.candidates.map((c) => {
    const u = dispositionUpdates.get(c.candidateId);
    if (!u) {
      return { ...c, disposition: "NOT_SELECTED" as const, reason: "not_selected" };
    }
    return { ...c, disposition: u.disposition, reason: u.reason };
  });

  const decision = buildPaymentSelectionDecision({
    createdAt,
    candidateSetHash: provisional.candidateSetHash,
    candidateObservationSetHash: provisional.candidateObservationSetHash,
    decisionPolicyId: policy.id,
    decisionPolicyVersion: policy.version,
    decisionPolicyHash: policyHash,
    evaluatedCandidates,
    decision: decisionKind,
    selectedCandidateId,
    selectedObservationId,
    selectionRationale: rationale,
    evidenceSufficiency,
    deferralConditions,
    rejectionReasons,
    expiresAt,
    objectiveId: objective.objectiveId,
    objectiveHash: objective.objectiveHash,
  });

  const set = buildCandidateDecisionSet(decision.evaluatedCandidates);

  return {
    objective,
    decision,
    set,
    matches,
    payment_authorized: false,
  };
}
