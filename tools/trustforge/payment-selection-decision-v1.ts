/**
 * payment-selection-decision-v1 — B.6 auditable BUY / DEFER / DONT_BUY decision.
 * Does NOT authorize payment, signing, credentials, or send.
 */

import {
  BLOCKED_B6_SELECTION_DECISION_TAMPER,
  BLOCKED_B6_SELECTION_STALE,
  GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION,
} from "./b6-execution-gates";
import {
  GUARD_SELECTION_DECISION_BINDS_OBJECTIVE,
  OBJECTIVE_SELECTION_BINDING_MISMATCH,
} from "./b61-execution-gates";
import type { CandidateDecisionEntry } from "./candidate-decision-set";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const PAYMENT_SELECTION_DECISION_SCHEMA =
  "trustforge_payment_selection_decision.v1" as const;

export type SelectionDecisionKind = "BUY" | "DEFER" | "DONT_BUY";

export type EvidenceSufficiency = "sufficient" | "partial" | "insufficient";

export interface SelectionRationaleItem {
  readonly code: string;
  readonly detail: string;
}

export interface PaymentSelectionDecisionV1 {
  readonly selectionDecisionId: string;
  readonly schemaVersion: typeof PAYMENT_SELECTION_DECISION_SCHEMA;
  readonly createdAt: string;
  readonly candidateSetHash: string;
  readonly candidateObservationSetHash: string;
  readonly decisionPolicyId: string;
  readonly decisionPolicyVersion: number;
  readonly decisionPolicyHash: string;
  readonly evaluatedCandidates: readonly CandidateDecisionEntry[];
  readonly decision: SelectionDecisionKind;
  readonly selectedCandidateId: string | null;
  readonly selectedObservationId: string | null;
  readonly selectionRationale: readonly SelectionRationaleItem[];
  readonly evidenceSufficiency: EvidenceSufficiency;
  readonly deferralConditions?: readonly SelectionRationaleItem[];
  readonly rejectionReasons?: readonly SelectionRationaleItem[];
  readonly selectionDecisionHash: string;
  readonly payment_authorized: false;
  /** Selection freshness — not the EIP-3009 / signing window. */
  readonly expiresAt: string;
  /** B.6.1: bound objective identity (null only for legacy non-objective decisions). */
  readonly objectiveId?: string | null;
  readonly objectiveHash?: string | null;
}

function decisionHashBody(
  decision: Omit<PaymentSelectionDecisionV1, "selectionDecisionHash">,
): Record<string, unknown> {
  return {
    selectionDecisionId: decision.selectionDecisionId,
    schemaVersion: decision.schemaVersion,
    createdAt: decision.createdAt,
    candidateSetHash: decision.candidateSetHash,
    candidateObservationSetHash: decision.candidateObservationSetHash,
    decisionPolicyId: decision.decisionPolicyId,
    decisionPolicyVersion: decision.decisionPolicyVersion,
    decisionPolicyHash: decision.decisionPolicyHash,
    evaluatedCandidates: decision.evaluatedCandidates,
    decision: decision.decision,
    selectedCandidateId: decision.selectedCandidateId,
    selectedObservationId: decision.selectedObservationId,
    selectionRationale: decision.selectionRationale,
    evidenceSufficiency: decision.evidenceSufficiency,
    deferralConditions: decision.deferralConditions ?? null,
    rejectionReasons: decision.rejectionReasons ?? null,
    payment_authorized: false,
    expiresAt: decision.expiresAt,
    objectiveId: decision.objectiveId ?? null,
    objectiveHash: decision.objectiveHash ?? null,
  };
}

export function paymentSelectionDecisionHash(
  decision: Omit<PaymentSelectionDecisionV1, "selectionDecisionHash"> | PaymentSelectionDecisionV1,
): string {
  const { selectionDecisionHash: _h, ...rest } = decision as PaymentSelectionDecisionV1 & {
    selectionDecisionHash?: string;
  };
  void _h;
  return canonicalJsonSha256(decisionHashBody(rest as Omit<PaymentSelectionDecisionV1, "selectionDecisionHash">));
}

export function buildPaymentSelectionDecision(
  input: Omit<PaymentSelectionDecisionV1, "selectionDecisionHash" | "payment_authorized" | "selectionDecisionId" | "schemaVersion"> & {
    readonly selectionDecisionId?: string;
  },
): PaymentSelectionDecisionV1 {
  void GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION;
  const partial: Omit<PaymentSelectionDecisionV1, "selectionDecisionHash"> = {
    selectionDecisionId:
      input.selectionDecisionId ??
      canonicalJsonSha256({
        candidateSetHash: input.candidateSetHash,
        decision: input.decision,
        selected: input.selectedCandidateId,
        createdAt: input.createdAt,
        policy: input.decisionPolicyHash,
      }).slice(0, 32),
    schemaVersion: PAYMENT_SELECTION_DECISION_SCHEMA,
    createdAt: input.createdAt,
    candidateSetHash: input.candidateSetHash,
    candidateObservationSetHash: input.candidateObservationSetHash,
    decisionPolicyId: input.decisionPolicyId,
    decisionPolicyVersion: input.decisionPolicyVersion,
    decisionPolicyHash: input.decisionPolicyHash,
    evaluatedCandidates: input.evaluatedCandidates,
    decision: input.decision,
    selectedCandidateId: input.selectedCandidateId,
    selectedObservationId: input.selectedObservationId,
    selectionRationale: input.selectionRationale,
    evidenceSufficiency: input.evidenceSufficiency,
    deferralConditions: input.deferralConditions,
    rejectionReasons: input.rejectionReasons,
    payment_authorized: false,
    expiresAt: input.expiresAt,
    objectiveId: input.objectiveId ?? null,
    objectiveHash: input.objectiveHash ?? null,
  };
  return {
    ...partial,
    selectionDecisionHash: paymentSelectionDecisionHash(partial),
  };
}

export function assertSelectionDecisionBindsObjective(input: {
  readonly decision: PaymentSelectionDecisionV1;
  readonly objectiveId: string;
  readonly objectiveHash: string;
}): { readonly ok: true; readonly guard: typeof GUARD_SELECTION_DECISION_BINDS_OBJECTIVE } {
  void GUARD_SELECTION_DECISION_BINDS_OBJECTIVE;
  if (!input.decision.objectiveId || !input.decision.objectiveHash) {
    throw new Error(
      `${OBJECTIVE_SELECTION_BINDING_MISMATCH}: decision missing objective binding`,
    );
  }
  if (input.decision.objectiveId !== input.objectiveId) {
    throw new Error(
      `${OBJECTIVE_SELECTION_BINDING_MISMATCH}: objectiveId mismatch`,
    );
  }
  if (input.decision.objectiveHash !== input.objectiveHash) {
    throw new Error(
      `${OBJECTIVE_SELECTION_BINDING_MISMATCH}: objectiveHash mismatch`,
    );
  }
  return { ok: true, guard: GUARD_SELECTION_DECISION_BINDS_OBJECTIVE };
}

export function assertSelectionDecisionIntegrity(
  decision: PaymentSelectionDecisionV1,
): { readonly ok: true } {
  const expected = paymentSelectionDecisionHash(decision);
  if (decision.selectionDecisionHash !== expected) {
    throw new Error(
      `${BLOCKED_B6_SELECTION_DECISION_TAMPER}: selectionDecisionHash mismatch`,
    );
  }
  if (decision.payment_authorized !== false) {
    throw new Error(
      `${BLOCKED_B6_SELECTION_DECISION_TAMPER}: ${GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION}`,
    );
  }
  if (decision.schemaVersion !== PAYMENT_SELECTION_DECISION_SCHEMA) {
    throw new Error(
      `${BLOCKED_B6_SELECTION_DECISION_TAMPER}: schemaVersion mismatch`,
    );
  }
  if (decision.decision === "BUY") {
    if (!decision.selectedCandidateId || !decision.selectedObservationId) {
      throw new Error(
        `${BLOCKED_B6_SELECTION_DECISION_TAMPER}: BUY missing selected ids`,
      );
    }
    const selected = decision.evaluatedCandidates.find(
      (c) => c.candidateId === decision.selectedCandidateId,
    );
    if (!selected || selected.disposition !== "SELECTED") {
      throw new Error(
        `${BLOCKED_B6_SELECTION_DECISION_TAMPER}: BUY selected disposition mismatch`,
      );
    }
    if (selected.observationId !== decision.selectedObservationId) {
      throw new Error(
        `${BLOCKED_B6_SELECTION_DECISION_TAMPER}: selectedObservationId mismatch`,
      );
    }
  } else {
    if (decision.selectedCandidateId !== null || decision.selectedObservationId !== null) {
      throw new Error(
        `${BLOCKED_B6_SELECTION_DECISION_TAMPER}: non-BUY must not select a candidate`,
      );
    }
  }
  return { ok: true };
}

export function assertSelectionDecisionFresh(input: {
  readonly decision: PaymentSelectionDecisionV1;
  readonly now: Date;
}): { readonly ok: true } {
  assertSelectionDecisionIntegrity(input.decision);
  const expires = Date.parse(input.decision.expiresAt);
  if (Number.isNaN(expires) || input.now.getTime() > expires) {
    throw new Error(
      `${BLOCKED_B6_SELECTION_STALE}: selection expired at ${input.decision.expiresAt}`,
    );
  }
  return { ok: true };
}
