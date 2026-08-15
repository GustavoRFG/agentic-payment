/**
 * authority-spend-reservation — future autonomous spend reservation boundary (B.6.3).
 * Synthetic only. No real fund reservation.
 */

import { AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION } from "./b63-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export type ReservationStatus =
  | "RESERVED"
  | "CONFIRMED"
  | "RELEASED"
  | "AMBIGUOUS";

export interface AuthoritySpendReservation {
  readonly schemaVersion: "trustforge_authority_spend_reservation.v1";
  readonly reservationId: string;
  readonly authorityId: string;
  readonly authorityHash: string;
  readonly paymentApprovalIntentHash: string;
  readonly paymentAuthorityDecisionHash: string;
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly createdAt: string;
  readonly status: ReservationStatus;
  readonly reservationHash: string;
}

export function authoritySpendReservationHash(
  r: Omit<AuthoritySpendReservation, "reservationHash">,
): string {
  return canonicalJsonSha256({
    schemaVersion: r.schemaVersion,
    reservationId: r.reservationId,
    authorityId: r.authorityId,
    authorityHash: r.authorityHash,
    paymentApprovalIntentHash: r.paymentApprovalIntentHash,
    paymentAuthorityDecisionHash: r.paymentAuthorityDecisionHash,
    amount: r.amount,
    asset: r.asset,
    network: r.network,
    createdAt: r.createdAt,
    status: r.status,
  });
}

export function buildAuthoritySpendReservation(
  input: Omit<
    AuthoritySpendReservation,
    "reservationHash" | "schemaVersion" | "reservationId"
  > & { readonly reservationId?: string },
): AuthoritySpendReservation {
  const reservationId =
    input.reservationId ??
    canonicalJsonSha256({
      authorityId: input.authorityId,
      intent: input.paymentApprovalIntentHash,
      createdAt: input.createdAt,
    }).slice(0, 32);
  const partial = {
    schemaVersion: "trustforge_authority_spend_reservation.v1" as const,
    reservationId,
    ...input,
  };
  return {
    ...partial,
    reservationHash: authoritySpendReservationHash(partial),
  };
}

/**
 * Future autonomous send MUST atomically reserve before signer/send.
 * B.6.3 documents this blocker; does not implement productive reservation.
 */
export function assertAtomicReservationRequiredBeforeAutonomousSend(): {
  readonly required: true;
  readonly code: typeof AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION;
} {
  return {
    required: true,
    code: AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION,
  };
}

/** Pre-JIT revalidation contract (documented + testable; no signer). */
export interface PreJitAuthorityRevalidationContract {
  readonly sequence: readonly string[];
  readonly notes: readonly string[];
}

export const PRE_JIT_AUTHORITY_REVALIDATION_CONTRACT: PreJitAuthorityRevalidationContract =
  {
    sequence: [
      "AUTONOMY_ALLOWED",
      "atomic authority budget reservation",
      "immediate authority revalidation",
      "immediate revocation recheck",
      "immediate live economic binding recheck",
      "only then JIT signing path",
    ],
    notes: [
      "B.6.3 does not invoke signer",
      "Revocation after decision but before JIT must BLOCK",
    ],
  };
