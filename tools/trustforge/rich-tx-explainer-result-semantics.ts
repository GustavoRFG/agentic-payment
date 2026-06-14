/**
 * rich-tx-explainer-result-semantics — RESULT field helpers (no network).
 */

import type { FactVerificationResult } from "./verify-tx-explainer-facts";
import type { OnchainPaymentVerification } from "./verify-base-usdc-payment";

export type SellerResponseKind =
  | "paid_response"
  | "free_response"
  | "error_response"
  | "ambiguous_response"
  | "none";

export type SettlementEvidenceStatus =
  | "onchain_verified"
  | "tx_hash_present_unverified"
  | "payment_header_no_tx_hash"
  | "no_payment_header"
  | "not_executed";

export type SellerResponseSemanticStatus =
  | "pass"
  | "fail"
  | "incomplete"
  | "verifier_false_negative";

export function classifySellerResponseKind(input: {
  readonly paymentAttempted: boolean;
  readonly httpStatus?: number | null;
}): SellerResponseKind {
  if (!input.paymentAttempted) {
    if (input.httpStatus === 200) return "free_response";
    if (input.httpStatus == null) return "none";
    if (input.httpStatus >= 400) return "error_response";
    return "ambiguous_response";
  }
  if (input.httpStatus === 200) return "paid_response";
  if (input.httpStatus == null) return "ambiguous_response";
  if (input.httpStatus >= 400) return "error_response";
  return "ambiguous_response";
}

export function resolveSettlementEvidenceStatus(input: {
  readonly paymentAttempted: boolean;
  readonly paymentTxHash?: string | null;
  readonly paymentResponseHeaderPresent?: boolean;
  readonly onchainPayment?: Pick<OnchainPaymentVerification, "status"> | null;
}): SettlementEvidenceStatus {
  if (!input.paymentAttempted) return "not_executed";
  if (input.onchainPayment?.status === "ONCHAIN_VERIFIED") return "onchain_verified";
  if (input.paymentTxHash) return "tx_hash_present_unverified";
  if (input.paymentResponseHeaderPresent) return "payment_header_no_tx_hash";
  return "no_payment_header";
}

export function resolveSellerResponseSemanticStatus(input: {
  readonly facts: FactVerificationResult;
  readonly verifierAdjusted?: boolean;
}): SellerResponseSemanticStatus {
  if (input.verifierAdjusted) return "verifier_false_negative";
  if (input.facts.passed) return "pass";
  if (input.facts.wrong_claims.length === 0) return "incomplete";
  const criticalWrong = input.facts.wrong_claims.some(
    (claim) =>
      claim.startsWith("tx_hash:") ||
      claim.startsWith("chain:") ||
      claim.startsWith("token_transfer:") ||
      claim.startsWith("amount:"),
  );
  return criticalWrong ? "fail" : "incomplete";
}
