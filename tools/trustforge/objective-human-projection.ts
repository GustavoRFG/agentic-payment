/**
 * objective-human-projection — deterministic human-readable rationale from hashed artifacts.
 * Presentation contract only. Does NOT open UI.
 */

import type { CapabilityMatchAssessment } from "./capability-match-assessment";
import type { PaymentDecisionObjectiveV1 } from "./payment-decision-objective-v1";
import type { PaymentSelectionDecisionV1 } from "./payment-selection-decision-v1";

export interface ObjectiveHumanProjectionV1 {
  readonly schemaVersion: "trustforge_objective_human_projection.v1";
  readonly objectiveSummary: {
    readonly whatIAsked: string;
    readonly requestedCapability: string;
    readonly acceptableOutputClasses: readonly string[];
    readonly maxBudget: string | null;
    readonly objectiveHash: string;
  };
  readonly selectedSummary: {
    readonly decision: string;
    readonly selectedCandidateId: string | null;
    readonly objectiveMatch: string | null;
    readonly why: string;
  };
  readonly alternatives: readonly {
    readonly candidateId: string;
    readonly disposition: string;
    readonly objectiveDisposition: string | null;
    readonly reason: string;
  }[];
  readonly projectionSource: "deterministic_hashed_artifacts";
}

export function projectObjectiveHumanRationale(input: {
  readonly objective: PaymentDecisionObjectiveV1;
  readonly decision: PaymentSelectionDecisionV1;
  readonly matches?: ReadonlyMap<string, CapabilityMatchAssessment>;
}): ObjectiveHumanProjectionV1 {
  const selected = input.decision.evaluatedCandidates.find(
    (c) => c.candidateId === input.decision.selectedCandidateId,
  );
  const selectedMatch = selected
    ? input.matches?.get(selected.candidateId)
    : undefined;

  return {
    schemaVersion: "trustforge_objective_human_projection.v1",
    objectiveSummary: {
      whatIAsked: input.objective.purpose,
      requestedCapability: input.objective.requestedCapability,
      acceptableOutputClasses: input.objective.acceptableOutputClasses,
      maxBudget: input.objective.maxBudget,
      objectiveHash: input.objective.objectiveHash,
    },
    selectedSummary: {
      decision: input.decision.decision,
      selectedCandidateId: input.decision.selectedCandidateId,
      objectiveMatch: selectedMatch?.match ?? selected?.objectiveDisposition ?? null,
      why:
        selectedMatch?.rationale ??
        input.decision.selectionRationale.map((r) => `${r.code}: ${r.detail}`).join(" | "),
    },
    alternatives: input.decision.evaluatedCandidates.map((c) => ({
      candidateId: c.candidateId,
      disposition: c.disposition,
      objectiveDisposition: c.objectiveDisposition ?? null,
      reason: c.reason,
    })),
    projectionSource: "deterministic_hashed_artifacts",
  };
}
