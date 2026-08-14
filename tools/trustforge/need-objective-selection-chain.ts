/**
 * need-objective-selection-chain — transitive hash-chain verification (B.6.2).
 */

import { GUARD_NEED_OBJECTIVE_SELECTION_INTENT_CHAIN } from "./b62-execution-gates";
import type { PaymentApprovalIntent } from "./payment-approval-intent";
import type { PaymentDecisionObjectiveV1 } from "./payment-decision-objective-v1";
import type { PaymentNeedV1 } from "./payment-need-v1";
import type { PaymentSelectionDecisionV1 } from "./payment-selection-decision-v1";
import type { NeedProvenanceAssessmentV1 } from "./need-provenance-assessment-v1";
import type { ObjectiveDerivationProofV1 } from "./objective-derivation-proof-v1";

export function verifyNeedObjectiveSelectionIntentChain(input: {
  readonly need: PaymentNeedV1;
  readonly provenance: NeedProvenanceAssessmentV1;
  readonly proof: ObjectiveDerivationProofV1;
  readonly objective: PaymentDecisionObjectiveV1;
  readonly decision: PaymentSelectionDecisionV1;
  readonly intent: PaymentApprovalIntent;
}): { readonly ok: true; readonly guard: typeof GUARD_NEED_OBJECTIVE_SELECTION_INTENT_CHAIN } {
  void GUARD_NEED_OBJECTIVE_SELECTION_INTENT_CHAIN;

  if (input.provenance.needHash !== input.need.needHash) {
    throw new Error("chain break: provenance.needHash != need.needHash");
  }
  if (input.proof.needHash !== input.need.needHash) {
    throw new Error("chain break: proof.needHash != need.needHash");
  }
  if (input.objective.needHash !== input.need.needHash) {
    throw new Error("chain break: objective.needHash != need.needHash");
  }
  if (input.objective.needProvenanceAssessmentHash !== input.provenance.assessmentHash) {
    throw new Error("chain break: objective.needProvenanceAssessmentHash");
  }
  if (input.objective.objectiveDerivationProofHash !== input.proof.proofHash) {
    throw new Error("chain break: objective.objectiveDerivationProofHash");
  }
  if (input.proof.objectiveHash !== input.objective.objectiveHash) {
    throw new Error("chain break: proof.objectiveHash != objective.objectiveHash");
  }
  if (input.decision.objectiveHash !== input.objective.objectiveHash) {
    throw new Error("chain break: decision.objectiveHash != objective.objectiveHash");
  }
  if (input.intent.selection_decision_hash !== input.decision.selectionDecisionHash) {
    throw new Error("chain break: intent.selection_decision_hash");
  }
  if (input.intent.objective_hash !== input.objective.objectiveHash) {
    throw new Error("chain break: intent.objective_hash");
  }
  if (input.intent.need_hash !== undefined && input.intent.need_hash !== input.need.needHash) {
    throw new Error("chain break: intent.need_hash");
  }
  if (input.intent.need_id !== undefined && input.intent.need_id !== input.need.needId) {
    throw new Error("chain break: intent.need_id");
  }
  return { ok: true, guard: GUARD_NEED_OBJECTIVE_SELECTION_INTENT_CHAIN };
}
