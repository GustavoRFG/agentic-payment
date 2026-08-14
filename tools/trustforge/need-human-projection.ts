/**
 * need-human-projection — deterministic human-readable need/objective rationale.
 * Presentation contract only. No UI. No post-hoc LLM narrative.
 */

import type { CapabilityMatchAssessment } from "./capability-match-assessment";
import type { NeedProvenanceAssessmentV1 } from "./need-provenance-assessment-v1";
import type { PaymentDecisionObjectiveV1 } from "./payment-decision-objective-v1";
import type { PaymentNeedV1 } from "./payment-need-v1";
import type { PaymentSelectionDecisionV1 } from "./payment-selection-decision-v1";

export interface NeedHumanProjectionV1 {
  readonly schemaVersion: "trustforge_need_human_projection.v1";
  readonly whyBuyingAnything: {
    readonly requestedOutcome: string;
    readonly originType: string;
    readonly originRef: string;
    readonly authorityClass: string;
    readonly provenanceStatus: string;
    readonly needHash: string;
  };
  readonly whatCapability: {
    readonly purpose: string;
    readonly requestedCapability: string;
    readonly objectiveHash: string;
  };
  readonly selected: {
    readonly decision: string;
    readonly selectedCandidateId: string | null;
    readonly match: string | null;
    readonly why: string;
  };
  readonly alternatives: readonly {
    readonly candidateId: string;
    readonly disposition: string;
    readonly reason: string;
  }[];
  readonly projectionSource: "deterministic_hashed_artifacts";
}

export function projectNeedHumanRationale(input: {
  readonly need: PaymentNeedV1;
  readonly provenance: NeedProvenanceAssessmentV1;
  readonly objective: PaymentDecisionObjectiveV1;
  readonly decision: PaymentSelectionDecisionV1;
  readonly matches?: ReadonlyMap<string, CapabilityMatchAssessment>;
}): NeedHumanProjectionV1 {
  const selected = input.decision.evaluatedCandidates.find(
    (c) => c.candidateId === input.decision.selectedCandidateId,
  );
  const selectedMatch = selected
    ? input.matches?.get(selected.candidateId)
    : undefined;

  return {
    schemaVersion: "trustforge_need_human_projection.v1",
    whyBuyingAnything: {
      requestedOutcome: input.need.requestedOutcome,
      originType: input.need.originType,
      originRef: input.need.originRef,
      authorityClass: input.provenance.authorityClass,
      provenanceStatus: input.provenance.provenanceStatus,
      needHash: input.need.needHash,
    },
    whatCapability: {
      purpose: input.objective.purpose,
      requestedCapability: input.objective.requestedCapability,
      objectiveHash: input.objective.objectiveHash,
    },
    selected: {
      decision: input.decision.decision,
      selectedCandidateId: input.decision.selectedCandidateId,
      match: selectedMatch?.match ?? null,
      why:
        selectedMatch?.rationale ??
        input.decision.selectionRationale.map((r) => `${r.code}: ${r.detail}`).join(" | "),
    },
    alternatives: input.decision.evaluatedCandidates.map((c) => ({
      candidateId: c.candidateId,
      disposition: c.disposition,
      reason: c.reason,
    })),
    projectionSource: "deterministic_hashed_artifacts",
  };
}

/** Negative: free-form post-hoc story is never a valid projection source. */
export function assertProjectionNotPostHocNarrative(projection: NeedHumanProjectionV1): void {
  if (projection.projectionSource !== "deterministic_hashed_artifacts") {
    throw new Error("BLOCKED_B62_POST_HOC_NEED_NARRATIVE");
  }
}
