/**
 * thin-settlement-outcome — three-outcome discriminator for thin x402 settlement.
 *
 * Crux: did USDC leave the wallet?
 */

import type { PaidProbeOutcome } from "./paid-probe-outcome";
import type { SettlementBindingRecord } from "./settlement-run-binding";
import { bindingConfirmsSettlement } from "./settlement-run-binding";

export type FacilitatorReceiptParseStatus = "parsed" | "missing" | "malformed" | "unsupported";

export interface ThinSettlementOutcomeInput {
  readonly httpStatus: number | null;
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly facilitatorReceiptParseStatus: FacilitatorReceiptParseStatus | null;
  readonly facilitatorReceiptPresent: boolean;
  readonly onChainBindingConfirmed: boolean;
  readonly balanceIdentityPass: boolean;
  readonly noNewOutboundTransfer: boolean;
  readonly reconciliationUnavailable: boolean;
  readonly reconciliationStatus: string | null;
  readonly binding: SettlementBindingRecord | null;
  readonly invariantsOk?: boolean;
}

export function classifyThinSettlementOutcome(
  input: ThinSettlementOutcomeInput,
): PaidProbeOutcome {
  if (input.reconciliationUnavailable) {
    return "BLOCKED_RECONCILIATION_UNAVAILABLE";
  }
  if (input.reconciliationStatus === "RECONCILIATION_RPC_TIMEOUT") {
    return "RECONCILIATION_RPC_TIMEOUT";
  }

  const bindingStatus = input.binding?.settlement_status ?? null;
  const bindingIndependentMatch = Boolean(input.binding?.independent_match?.settlement_tx_hash);

  if (bindingStatus === "hash_mismatch" && bindingIndependentMatch && input.paymentAttempted) {
    return "FAIL_SETTLEMENT_HASH_MISMATCH";
  }
  if (bindingStatus === "ambiguous_match" && input.paymentAttempted) {
    return "FAIL";
  }
  if (bindingStatus === "facilitator_receipt_missing" && bindingIndependentMatch && input.paymentAttempted) {
    return "SETTLED_ONCHAIN_FACILITATOR_RECEIPT_MISSING";
  }
  if (bindingStatus === "facilitator_receipt_malformed" && bindingIndependentMatch && input.paymentAttempted) {
    return "SETTLED_ONCHAIN_FACILITATOR_RECEIPT_MALFORMED";
  }
  if (bindingStatus === "facilitator_hash_missing" && bindingIndependentMatch && input.paymentAttempted) {
    return "SETTLED_ONCHAIN_FACILITATOR_HASH_MISSING";
  }

  const httpOk = input.httpStatus !== null && input.httpStatus >= 200 && input.httpStatus < 300;
  const receiptEvidence =
    input.facilitatorReceiptPresent ||
    input.facilitatorReceiptParseStatus === "parsed" ||
    input.paymentAttempted;

  if (
    input.paymentAttempted &&
    httpOk &&
    receiptEvidence &&
    !input.onChainBindingConfirmed
  ) {
    return "FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN";
  }

  if (
    input.paymentAttempted &&
    input.onChainBindingConfirmed &&
    input.balanceIdentityPass &&
    input.binding &&
    bindingConfirmsSettlement(input.binding) &&
    input.invariantsOk !== false
  ) {
    return "PASS_SETTLED";
  }

  const sellerDeclined =
    !input.paymentAttempted ||
    (input.httpStatus !== null && (input.httpStatus === 402 || input.httpStatus >= 400)) ||
    (!input.facilitatorReceiptPresent && input.facilitatorReceiptParseStatus === "missing");

  if (
    sellerDeclined &&
    input.noNewOutboundTransfer &&
    input.balanceIdentityPass &&
    input.paymentBearingHttpRequestCount <= 1
  ) {
    return "PASS_NO_SETTLE_CLEAN";
  }

  if (!input.paymentAttempted && input.paymentBearingHttpRequestCount === 0 && input.noNewOutboundTransfer) {
    return "PASS_NO_SETTLE_CLEAN";
  }

  if (input.paymentAttempted && !input.onChainBindingConfirmed) {
    return "FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN";
  }

  return "FAIL";
}

export function detailForThinSettlementOutcome(outcome: PaidProbeOutcome): string {
  switch (outcome) {
    case "PASS_SETTLED":
      return "Thin settlement proof complete";
    case "PASS_NO_SETTLE_CLEAN":
      return "Seller declined or no payment; no outbound USDC transfer detected";
    case "FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN":
      return "Payment evidence without matching on-chain Transfer";
    case "FAIL_SETTLEMENT_HASH_MISMATCH":
      return "Facilitator hash differs from independent on-chain Transfer";
    case "SETTLED_ONCHAIN_FACILITATOR_RECEIPT_MISSING":
      return "Independent on-chain match; facilitator receipt missing";
    case "SETTLED_ONCHAIN_FACILITATOR_RECEIPT_MALFORMED":
      return "Independent on-chain match; facilitator receipt malformed";
    case "SETTLED_ONCHAIN_FACILITATOR_HASH_MISSING":
      return "Independent on-chain match; facilitator hash missing";
    case "RECONCILIATION_RPC_TIMEOUT":
      return "Reconciliation exceeded bounded RPC deadline";
    case "BLOCKED_RECONCILIATION_UNAVAILABLE":
      return "Reconciliation unavailable; not a settlement verdict";
    default:
      return `classified ${outcome}`;
  }
}
