/**
 * paid-probe-outcome — three-outcome paid probe classification.
 *
 * RPC unavailable must never be classified as settlement-not-found or no-settle-clean.
 */

export type PaidProbeOutcome =
  | "PASS_SETTLED"
  | "PASS_NO_SETTLE_CLEAN"
  | "FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN"
  | "SETTLED_ONCHAIN_FACILITATOR_HASH_MISSING"
  | "FAIL"
  | "BLOCKED_RECONCILIATION_UNAVAILABLE";

export interface PaidProbeOutcomeInput {
  readonly paymentAttempted: boolean;
  readonly onChainConfirmed: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly sellerHttpSuccessWithoutSettlement?: boolean;
  readonly reconciliationUnavailable?: boolean;
  readonly invariantsOk?: boolean;
}

export function classifyPaidProbeOutcome(input: PaidProbeOutcomeInput): PaidProbeOutcome {
  if (input.reconciliationUnavailable) {
    return "BLOCKED_RECONCILIATION_UNAVAILABLE";
  }

  if (
    input.paymentAttempted &&
    !input.onChainConfirmed
  ) {
    return "FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN";
  }

  if (
    !input.paymentAttempted &&
    input.paymentBearingHttpRequestCount === 0
  ) {
    return "PASS_NO_SETTLE_CLEAN";
  }

  if (
    input.paymentAttempted &&
    input.onChainConfirmed &&
    input.invariantsOk !== false
  ) {
    return "PASS_SETTLED";
  }

  return "FAIL";
}
