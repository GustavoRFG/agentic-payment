/**
 * payment-authority-decision-v1 — immutable autonomy evaluation result (B.6.3).
 * AUTONOMY_ALLOWED != SEND.
 */

import type { AutonomyOutcome } from "./b63-execution-gates";
import { GUARD_AUTHORITY_DECISION_BINDS_PAYMENT_APPROVAL_INTENT } from "./b63-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const PAYMENT_AUTHORITY_DECISION_SCHEMA =
  "trustforge_payment_authority_decision.v1" as const;

export const AUTHORITY_DECISION_POLICY_ID =
  "trustforge_b63_authority_decision_policy" as const;
export const AUTHORITY_DECISION_POLICY_VERSION = 1 as const;

export interface PaymentAuthorityDecisionV1 {
  readonly decisionId: string;
  readonly schemaVersion: typeof PAYMENT_AUTHORITY_DECISION_SCHEMA;
  readonly createdAt: string;
  readonly authorityId: string | null;
  readonly authorityHash: string | null;
  readonly needId: string;
  readonly needHash: string;
  readonly objectiveId: string;
  readonly objectiveHash: string;
  readonly selectionDecisionId: string;
  readonly selectionDecisionHash: string;
  readonly paymentApprovalIntentId: string;
  readonly paymentApprovalIntentHash: string;
  readonly liveRequirementsHash: string | null;
  readonly liveObservedAt: string | null;
  readonly liveAmountAtomic: string;
  readonly consumptionLedgerViewHash: string | null;
  readonly revocationLedgerViewHash: string | null;
  readonly sellerExecutionHistoryHash: string | null;
  readonly decision: AutonomyOutcome;
  readonly matchedConstraints: readonly string[];
  readonly failedConstraints: readonly string[];
  readonly humanRequiredReasons: readonly string[];
  readonly availableBudgetBefore: string | null;
  readonly proposedAmount: string;
  readonly availableBudgetAfterIfExecuted: string | null;
  readonly decisionPolicyId: typeof AUTHORITY_DECISION_POLICY_ID;
  readonly decisionPolicyVersion: typeof AUTHORITY_DECISION_POLICY_VERSION;
  readonly decisionPolicyHash: string;
  readonly decisionHash: string;
  readonly payment_authorized: false;
  readonly send_authorized: false;
}

export function authorityDecisionPolicyHash(): string {
  return canonicalJsonSha256({
    id: AUTHORITY_DECISION_POLICY_ID,
    version: AUTHORITY_DECISION_POLICY_VERSION,
    payment_authorized: false,
    send_authorized: false,
  });
}

function decisionHashBody(
  d: Omit<PaymentAuthorityDecisionV1, "decisionHash">,
): Record<string, unknown> {
  return {
    decisionId: d.decisionId,
    schemaVersion: d.schemaVersion,
    createdAt: d.createdAt,
    authorityId: d.authorityId,
    authorityHash: d.authorityHash,
    needId: d.needId,
    needHash: d.needHash,
    objectiveId: d.objectiveId,
    objectiveHash: d.objectiveHash,
    selectionDecisionId: d.selectionDecisionId,
    selectionDecisionHash: d.selectionDecisionHash,
    paymentApprovalIntentId: d.paymentApprovalIntentId,
    paymentApprovalIntentHash: d.paymentApprovalIntentHash,
    liveRequirementsHash: d.liveRequirementsHash,
    liveObservedAt: d.liveObservedAt,
    liveAmountAtomic: d.liveAmountAtomic,
    consumptionLedgerViewHash: d.consumptionLedgerViewHash,
    revocationLedgerViewHash: d.revocationLedgerViewHash,
    sellerExecutionHistoryHash: d.sellerExecutionHistoryHash,
    decision: d.decision,
    matchedConstraints: [...d.matchedConstraints],
    failedConstraints: [...d.failedConstraints],
    humanRequiredReasons: [...d.humanRequiredReasons],
    availableBudgetBefore: d.availableBudgetBefore,
    proposedAmount: d.proposedAmount,
    availableBudgetAfterIfExecuted: d.availableBudgetAfterIfExecuted,
    decisionPolicyId: d.decisionPolicyId,
    decisionPolicyVersion: d.decisionPolicyVersion,
    decisionPolicyHash: d.decisionPolicyHash,
    payment_authorized: false,
    send_authorized: false,
  };
}

export function paymentAuthorityDecisionHash(
  d: Omit<PaymentAuthorityDecisionV1, "decisionHash"> | PaymentAuthorityDecisionV1,
): string {
  const { decisionHash: _h, ...rest } = d as PaymentAuthorityDecisionV1 & {
    decisionHash?: string;
  };
  void _h;
  return canonicalJsonSha256(
    decisionHashBody(rest as Omit<PaymentAuthorityDecisionV1, "decisionHash">),
  );
}

export function buildPaymentAuthorityDecision(
  input: Omit<
    PaymentAuthorityDecisionV1,
    | "decisionHash"
    | "schemaVersion"
    | "decisionPolicyId"
    | "decisionPolicyVersion"
    | "decisionPolicyHash"
    | "payment_authorized"
    | "send_authorized"
    | "decisionId"
  > & { readonly decisionId?: string },
): PaymentAuthorityDecisionV1 {
  const policyHash = authorityDecisionPolicyHash();
  const partial: Omit<PaymentAuthorityDecisionV1, "decisionHash"> = {
    decisionId:
      input.decisionId ??
      canonicalJsonSha256({
        intent: input.paymentApprovalIntentHash,
        decision: input.decision,
        createdAt: input.createdAt,
      }).slice(0, 32),
    schemaVersion: PAYMENT_AUTHORITY_DECISION_SCHEMA,
    createdAt: input.createdAt,
    authorityId: input.authorityId,
    authorityHash: input.authorityHash,
    needId: input.needId,
    needHash: input.needHash,
    objectiveId: input.objectiveId,
    objectiveHash: input.objectiveHash,
    selectionDecisionId: input.selectionDecisionId,
    selectionDecisionHash: input.selectionDecisionHash,
    paymentApprovalIntentId: input.paymentApprovalIntentId,
    paymentApprovalIntentHash: input.paymentApprovalIntentHash,
    liveRequirementsHash: input.liveRequirementsHash,
    liveObservedAt: input.liveObservedAt,
    liveAmountAtomic: input.liveAmountAtomic,
    consumptionLedgerViewHash: input.consumptionLedgerViewHash,
    revocationLedgerViewHash: input.revocationLedgerViewHash,
    sellerExecutionHistoryHash: input.sellerExecutionHistoryHash,
    decision: input.decision,
    matchedConstraints: input.matchedConstraints,
    failedConstraints: input.failedConstraints,
    humanRequiredReasons: input.humanRequiredReasons,
    availableBudgetBefore: input.availableBudgetBefore,
    proposedAmount: input.proposedAmount,
    availableBudgetAfterIfExecuted: input.availableBudgetAfterIfExecuted,
    decisionPolicyId: AUTHORITY_DECISION_POLICY_ID,
    decisionPolicyVersion: AUTHORITY_DECISION_POLICY_VERSION,
    decisionPolicyHash: policyHash,
    payment_authorized: false,
    send_authorized: false,
  };
  return {
    ...partial,
    decisionHash: paymentAuthorityDecisionHash(partial),
  };
}

export function assertAuthorityDecisionBindsIntent(input: {
  readonly decision: PaymentAuthorityDecisionV1;
  readonly paymentApprovalIntentHash: string;
}): void {
  void GUARD_AUTHORITY_DECISION_BINDS_PAYMENT_APPROVAL_INTENT;
  if (
    input.decision.paymentApprovalIntentHash !== input.paymentApprovalIntentHash
  ) {
    throw new Error(
      `${GUARD_AUTHORITY_DECISION_BINDS_PAYMENT_APPROVAL_INTENT}: intent hash mismatch`,
    );
  }
}
