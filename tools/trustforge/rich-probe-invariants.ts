/**
 * rich-probe-invariants — settlement-first rich probe eligibility and invariants.
 */

import type { PaymentIntegrityOutcome } from "./payment-attempt-ledger";
import type { SettlementEvidenceStatus, TransactionHashSource } from "./settlement-evidence";

export type SemanticEvaluationStatus = "pass" | "fail" | "incomplete" | "unknown";

export interface RichProbeEligibility {
  readonly paymentIntegrityEligible: boolean;
  readonly semanticEligible: boolean;
  readonly trustScoreEligible: boolean;
  readonly blockedReasons: readonly string[];
}

export interface RichProbeInvariantSnapshot {
  readonly quote_usdc: string | null;
  readonly actual_spend_usdc: string | null;
  readonly actual_total_spend_usdc?: string | null;
  readonly transaction_hash: string | null;
  readonly transaction_hash_source: TransactionHashSource;
  readonly settlement_evidence_status: SettlementEvidenceStatus | string;
  readonly saved_settlement_evidence_status?: string | null;
  readonly onchain_reconciliation_status?: string | null;
  readonly payment_integrity_status: PaymentIntegrityOutcome | string;
  readonly payment_bearing_http_request_count: number;
  readonly trust_score_rich_created: boolean;
  readonly semantic_evaluation_status: SemanticEvaluationStatus | string;
  readonly seller_response_semantic_status?: string | null;
  readonly onchain_payment_verification_status?: string | null;
  readonly chain_reconciliation_attempted?: boolean;
  readonly http_status?: number | null;
}

export function evaluateRichProbeEligibility(input: {
  readonly paymentIntegrityStatus: PaymentIntegrityOutcome | string;
  readonly semanticEvaluationStatus: SemanticEvaluationStatus | string;
}): RichProbeEligibility {
  const blockedReasons: string[] = [];
  const paymentPass = input.paymentIntegrityStatus === "pass";
  const semanticPass = input.semanticEvaluationStatus === "pass";

  if (!paymentPass) {
    blockedReasons.push(`payment_integrity:${input.paymentIntegrityStatus}`);
  }
  if (!semanticPass) {
    blockedReasons.push(`semantic_evaluation:${input.semanticEvaluationStatus}`);
  }

  return {
    paymentIntegrityEligible: paymentPass,
    semanticEligible: semanticPass,
    trustScoreEligible: paymentPass && semanticPass,
    blockedReasons,
  };
}

export function assertRichProbeInvariants(
  snapshot: RichProbeInvariantSnapshot,
): { readonly passed: boolean; readonly violations: readonly string[] } {
  const violations: string[] = [];

  if (
    snapshot.actual_spend_usdc != null &&
    !snapshot.transaction_hash &&
    !snapshot.transaction_hash_source
  ) {
    violations.push("actual_spend_usdc set without transaction_hash or source");
  }

  if (
    snapshot.trust_score_rich_created &&
    snapshot.payment_integrity_status !== "pass"
  ) {
    violations.push("trust_score_rich_created while payment_integrity != pass");
  }

  if (
    snapshot.trust_score_rich_created &&
    snapshot.semantic_evaluation_status !== "pass"
  ) {
    violations.push("trust_score_rich_created while semantic_evaluation != pass");
  }

  if (
    snapshot.onchain_payment_verification_status === "ONCHAIN_VERIFIED" &&
    !snapshot.transaction_hash
  ) {
    violations.push("ONCHAIN_VERIFIED with null transaction_hash");
  }

  if (
    snapshot.payment_bearing_http_request_count > 0 &&
    (snapshot.settlement_evidence_status === "missing_header_tx_hash" ||
      snapshot.settlement_evidence_status === "missing_payment_metadata") &&
    snapshot.chain_reconciliation_attempted === false
  ) {
    violations.push(
      "payment-bearing request with missing header tx hash but chain reconciliation not attempted",
    );
  }

  if (
    snapshot.quote_usdc &&
    snapshot.actual_spend_usdc === snapshot.quote_usdc &&
    !snapshot.transaction_hash &&
    !snapshot.transaction_hash_source
  ) {
    violations.push("quote_usdc copied into actual_spend_usdc without settlement evidence");
  }

  if (snapshot.http_status === 200 && snapshot.payment_integrity_status === "pass" && !snapshot.transaction_hash) {
    violations.push("HTTP 200 treated as payment_integrity pass without transaction_hash");
  }

  if (
    snapshot.transaction_hash == null &&
    snapshot.payment_bearing_http_request_count > 0 &&
    snapshot.onchain_reconciliation_status === "not_executed" &&
    snapshot.settlement_evidence_status === "no_settlement_found_onchain"
  ) {
    // allowed only after reconciliation attempted — checked above
  }

  return { passed: violations.length === 0, violations };
}

export function positiveScoreBlockedReason(
  eligibility: RichProbeEligibility,
): string | null {
  if (eligibility.trustScoreEligible) return null;
  return eligibility.blockedReasons.join("; ") || "trust score ineligible";
}
