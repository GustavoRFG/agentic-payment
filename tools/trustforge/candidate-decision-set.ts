/**
 * candidate-decision-set — frozen set of alternatives considered by B.6.
 * A decision must bind this set; set drift invalidates the old decision.
 */

import {
  GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET,
  BLOCKED_B6_SELECTION_SET_DRIFT,
} from "./b6-execution-gates";
import type { CandidatePolicyVerdictKind } from "./payment-candidate-policy";
import type { UtilityEvidenceClass, OrdinalValue } from "./economic-assessment-v2";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export type CandidateDisposition =
  | "SELECTED"
  | "NOT_SELECTED"
  | "DEFERRED"
  | "INELIGIBLE"
  | "UNSUPPORTED"
  | "OUT_OF_SCOPE_OBJECTIVE";

export type ObjectiveDisposition =
  | "IN_SCOPE"
  | "OUT_OF_SCOPE_OBJECTIVE"
  | "OBJECTIVE_UNKNOWN"
  | "OBJECTIVE_PARTIAL"
  | "OBJECTIVE_BUDGET_EXCEEDED"
  | "NO_OBJECTIVE_APPLIED";

export interface CandidateDecisionEntry {
  readonly candidateId: string;
  readonly observationId: string;
  readonly eligibility: CandidatePolicyVerdictKind;
  readonly costAtomic: string | "unknown";
  readonly utilityEvidenceClass: UtilityEvidenceClass;
  readonly utilityConfidence: OrdinalValue;
  readonly riskFlags: readonly string[];
  readonly freshnessObservedAt: string;
  readonly rankingInputs: Readonly<Record<string, string | number | boolean | null>>;
  readonly disposition: CandidateDisposition;
  readonly reason: string;
  readonly purpose?: string | "unknown";
  readonly candidateSha256?: string;
  readonly policyVerdictSha256?: string;
  readonly economicAssessmentSha256?: string;
  /** B.6.1: hash of CapabilityMatchAssessment when objective-bound. */
  readonly capabilityMatchAssessmentHash?: string;
  /** B.6.1: objective-scope disposition before economic ranking. */
  readonly objectiveDisposition?: ObjectiveDisposition;
}

export interface CandidateDecisionSet {
  readonly schemaVersion: "trustforge_candidate_decision_set.v1";
  readonly candidates: readonly CandidateDecisionEntry[];
  readonly candidateSetHash: string;
  readonly candidateObservationSetHash: string;
}

export function candidateSetHashFromIds(candidateIds: readonly string[]): string {
  return canonicalJsonSha256([...candidateIds].sort());
}

export function candidateObservationSetHashFromPairs(
  pairs: readonly { readonly candidateId: string; readonly observationId: string }[],
): string {
  const normalized = [...pairs]
    .map((p) => ({
      candidateId: p.candidateId,
      observationId: p.observationId,
    }))
    .sort((a, b) =>
      a.candidateId === b.candidateId
        ? a.observationId.localeCompare(b.observationId)
        : a.candidateId.localeCompare(b.candidateId),
    );
  return canonicalJsonSha256(normalized);
}

export function buildCandidateDecisionSet(
  candidates: readonly CandidateDecisionEntry[],
): CandidateDecisionSet {
  const candidateSetHash = candidateSetHashFromIds(candidates.map((c) => c.candidateId));
  const candidateObservationSetHash = candidateObservationSetHashFromPairs(
    candidates.map((c) => ({
      candidateId: c.candidateId,
      observationId: c.observationId,
    })),
  );
  return {
    schemaVersion: "trustforge_candidate_decision_set.v1",
    candidates,
    candidateSetHash,
    candidateObservationSetHash,
  };
}

export function withUpdatedDispositions(
  set: CandidateDecisionSet,
  updates: ReadonlyMap<string, { disposition: CandidateDisposition; reason: string }>,
): CandidateDecisionSet {
  const candidates = set.candidates.map((c) => {
    const u = updates.get(c.candidateId);
    if (!u) return c;
    return { ...c, disposition: u.disposition, reason: u.reason };
  });
  return buildCandidateDecisionSet(candidates);
}

export function assertDecisionBindsCandidateSet(input: {
  readonly candidateSetHash: string;
  readonly candidateObservationSetHash: string;
  readonly set: CandidateDecisionSet;
}): {
  readonly ok: true;
  readonly guard: typeof GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET;
} {
  void GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET;
  if (input.candidateSetHash !== input.set.candidateSetHash) {
    throw new Error(
      `${BLOCKED_B6_SELECTION_SET_DRIFT}: ${GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET} candidateSetHash mismatch`,
    );
  }
  if (input.candidateObservationSetHash !== input.set.candidateObservationSetHash) {
    throw new Error(
      `${BLOCKED_B6_SELECTION_SET_DRIFT}: ${GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET} candidateObservationSetHash mismatch`,
    );
  }
  const recomputed = buildCandidateDecisionSet(input.set.candidates);
  if (
    recomputed.candidateSetHash !== input.set.candidateSetHash ||
    recomputed.candidateObservationSetHash !== input.set.candidateObservationSetHash
  ) {
    throw new Error(
      `${BLOCKED_B6_SELECTION_SET_DRIFT}: ${GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET} set hash tamper`,
    );
  }
  return { ok: true, guard: GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET };
}
