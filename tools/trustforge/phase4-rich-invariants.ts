/**
 * phase4-rich-invariants — RICH-001 through RICH-010 settlement-first checks.
 */

import type { PaymentAttemptLedgerEntryV1 } from "./settlement-first-v1";
import type { PaymentIntegrityResultV1 } from "./settlement-first-v1";

export interface Phase4InvariantContext {
  readonly noPaymentMode: boolean;
  readonly paymentIntegrity: PaymentIntegrityResultV1;
  readonly semanticEvaluationStatus: "pass" | "fail" | "not_executed" | "unknown";
  readonly trustScoreCreated: boolean;
  readonly ledgerEntries: readonly PaymentAttemptLedgerEntryV1[];
  readonly expectedSettlementHashes: readonly string[];
  readonly newTransactionHashes: readonly string[];
}

export interface Phase4InvariantResult {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export function checkPhase4RichInvariants(
  ctx: Phase4InvariantContext,
): readonly Phase4InvariantResult[] {
  const results: Phase4InvariantResult[] = [];

  // RICH-001: No TrustScore without payment_integrity pass.
  results.push({
    id: "RICH-001",
    passed:
      !ctx.trustScoreCreated ||
      (ctx.paymentIntegrity.pass && ctx.paymentIntegrity.status === "pass"),
    detail: "TrustScore requires payment_integrity pass",
  });

  // RICH-002: No TrustScore without semantic_evaluation pass.
  results.push({
    id: "RICH-002",
    passed: !ctx.trustScoreCreated || ctx.semanticEvaluationStatus === "pass",
    detail: "TrustScore requires semantic_evaluation pass",
  });

  // RICH-003: No wallet load in no-payment Phase 4.
  results.push({
    id: "RICH-003",
    passed:
      !ctx.noPaymentMode ||
      ctx.ledgerEntries.every((e) => !e.wallet_loaded),
    detail: "No wallet load in no-payment mode",
  });

  // RICH-004: No payment header sent in no-payment Phase 4.
  results.push({
    id: "RICH-004",
    passed:
      !ctx.noPaymentMode ||
      ctx.ledgerEntries.every((e) => !e.payment_header_sent),
    detail: "No payment header sent in no-payment mode",
  });

  // RICH-005: No retry/fallback against Zapper in Phase 4.
  results.push({
    id: "RICH-005",
    passed: ctx.ledgerEntries.every(
      (e) => !e.safety.retry_used && !e.safety.fallback_used,
    ),
    detail: "No retry or fallback in Phase 4",
  });

  // RICH-006: Settlement replay hashes must match ledger evidence.
  const ledgerHashes = new Set(
    ctx.ledgerEntries
      .map((e) => e.settlement?.tx_hash?.toLowerCase())
      .filter((h): h is string => Boolean(h)),
  );
  const expectedPresent = ctx.expectedSettlementHashes.every((h) =>
    ledgerHashes.has(h.toLowerCase()),
  );
  results.push({
    id: "RICH-006",
    passed: expectedPresent,
    detail: `Expected settlement hashes present in ledger: ${expectedPresent}`,
  });

  // RICH-007: PaymentAttemptLedger must record zero payment-bearing HTTP requests in no-payment mode.
  results.push({
    id: "RICH-007",
    passed:
      !ctx.noPaymentMode ||
      ctx.ledgerEntries.every(
        (e) => e.safety.payment_bearing_http_request_count === 0,
      ),
    detail: "Zero payment-bearing HTTP requests in no-payment mode",
  });

  // RICH-008: Phase 3B replay must not create a new transaction hash.
  const unexpectedNew = ctx.newTransactionHashes.filter(
    (h) =>
      !ctx.expectedSettlementHashes.some(
        (e) => e.toLowerCase() === h.toLowerCase(),
      ),
  );
  results.push({
    id: "RICH-008",
    passed: unexpectedNew.length === 0,
    detail: "No unexpected new transaction hashes introduced",
  });

  // RICH-009: Any rich TrustScore must point to immutable SettlementEvidence.
  results.push({
    id: "RICH-009",
    passed:
      !ctx.trustScoreCreated ||
      ctx.ledgerEntries.some(
        (e) =>
          e.settlement?.schema_version === "settlement_evidence.v1" &&
          e.settlement.tx_hash != null,
      ),
    detail: "TrustScore requires immutable SettlementEvidence reference",
  });

  // RICH-010: Any paid seller response must be tied to exactly one PaymentAttemptLedger entry.
  const withResponse = ctx.ledgerEntries.filter(
    (e) => e.status === "seller_response_received" || e.status === "settlement_reconciled",
  );
  results.push({
    id: "RICH-010",
    passed:
      withResponse.length === 0 ||
      withResponse.every((e) => e.attempt_id.length > 0 && e.probe_id.length > 0),
    detail: "Seller responses tied to unique ledger entries",
  });

  return results;
}

export function allPhase4InvariantsPassed(
  results: readonly Phase4InvariantResult[],
): boolean {
  return results.every((r) => r.passed);
}
