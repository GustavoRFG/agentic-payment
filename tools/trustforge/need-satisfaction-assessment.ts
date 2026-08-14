/**
 * need-satisfaction-assessment — future-facing need closeout (B.6.2 engineering).
 * Does NOT authorize repurchase. SATISFIED needs cannot trigger new BUY.
 */

import { GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY } from "./b62-execution-gates";
import {
  assertNeedIntegrity,
  withNeedLifecycle,
  type PaymentNeedV1,
} from "./payment-need-v1";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const NEED_SATISFACTION_ASSESSMENT_SCHEMA =
  "trustforge_need_satisfaction_assessment.v1" as const;

export type NeedSatisfactionStatus =
  | "SATISFIED"
  | "PARTIAL"
  | "UNSATISFIED"
  | "UNASSESSABLE";

export interface NeedSatisfactionAssessmentV1 {
  readonly schemaVersion: typeof NEED_SATISFACTION_ASSESSMENT_SCHEMA;
  readonly needId: string;
  readonly needHash: string;
  readonly status: NeedSatisfactionStatus;
  readonly deliveredUtilityRef: string | null;
  readonly selectionDecisionHash: string | null;
  readonly rationale: string;
  readonly assessmentHash: string;
  readonly payment_authorized: false;
  readonly repurchase_authorized: false;
}

export function needSatisfactionAssessmentHash(
  a: Omit<NeedSatisfactionAssessmentV1, "assessmentHash">,
): string {
  return canonicalJsonSha256({
    schemaVersion: a.schemaVersion,
    needId: a.needId,
    needHash: a.needHash,
    status: a.status,
    deliveredUtilityRef: a.deliveredUtilityRef,
    selectionDecisionHash: a.selectionDecisionHash,
    rationale: a.rationale,
    payment_authorized: false,
    repurchase_authorized: false,
  });
}

export function buildNeedSatisfactionAssessment(input: {
  readonly need: PaymentNeedV1;
  readonly status: NeedSatisfactionStatus;
  readonly deliveredUtilityRef?: string | null;
  readonly selectionDecisionHash?: string | null;
  readonly rationale: string;
}): NeedSatisfactionAssessmentV1 {
  assertNeedIntegrity(input.need);
  const partial: Omit<NeedSatisfactionAssessmentV1, "assessmentHash"> = {
    schemaVersion: NEED_SATISFACTION_ASSESSMENT_SCHEMA,
    needId: input.need.needId,
    needHash: input.need.needHash,
    status: input.status,
    deliveredUtilityRef: input.deliveredUtilityRef ?? null,
    selectionDecisionHash: input.selectionDecisionHash ?? null,
    rationale: input.rationale,
    payment_authorized: false,
    repurchase_authorized: false,
  };
  return {
    ...partial,
    assessmentHash: needSatisfactionAssessmentHash(partial),
  };
}

export function markNeedSatisfied(input: {
  readonly need: PaymentNeedV1;
  readonly assessment: NeedSatisfactionAssessmentV1;
}): PaymentNeedV1 {
  if (input.assessment.status !== "SATISFIED") {
    throw new Error("markNeedSatisfied requires SATISFIED assessment");
  }
  if (input.assessment.needHash !== input.need.needHash) {
    throw new Error("satisfaction assessment needHash mismatch");
  }
  return withNeedLifecycle(input.need, "SATISFIED");
}

export function assertSatisfiedNeedCannotBuy(need: PaymentNeedV1): void {
  void GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY;
  if (need.lifecycleState === "SATISFIED") {
    throw new Error(
      `${GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY}: need ${need.needId}`,
    );
  }
}
