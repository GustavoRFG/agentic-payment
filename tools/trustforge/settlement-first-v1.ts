/**
 * settlement-first-v1 — Phase 4 codex v1 schema types and adapters.
 * Adapts existing settlement-first models without breaking Phase 2/3 artifacts.
 */

import type { PaymentAttemptLedgerEntry } from "./payment-attempt-ledger";
import type { SettlementEvidence as LegacySettlementEvidence } from "./settlement-evidence";

export type SettlementEvidenceStatus =
  | "pass"
  | "fail"
  | "not_executed"
  | "unknown";

export interface SettlementEvidenceV1 {
  schema_version: "settlement_evidence.v1";
  status: SettlementEvidenceStatus;
  chain_id: number | null;
  network: string | null;
  tx_hash: string | null;
  block_number: number | null;
  payer: string | null;
  payee: string | null;
  token: {
    address: string | null;
    symbol: string | null;
    decimals: number | null;
  };
  amount: {
    raw: string | null;
    human: string | null;
    currency: string | null;
  };
  settlement_recipient_matches_quote: boolean | null;
  settlement_amount_matches_quote: boolean | null;
  settlement_chain_matches_quote: boolean | null;
  confirmations: number | null;
  explorer_url: string | null;
  evidence_source: "offline_replay" | "live_reconciled" | "fixture" | "not_available";
  reconciled_at: string | null;
  failure_reason?: string;
  missing_fields?: readonly string[];
}

export type PaymentAttemptStatus =
  | "not_attempted"
  | "quoted_unpaid"
  | "payment_header_prepared"
  | "payment_header_sent"
  | "seller_response_received"
  | "settlement_reconciled"
  | "failed"
  | "blocked_by_policy";

export interface PaymentAttemptLedgerEntryV1 {
  schema_version: "payment_attempt_ledger_entry.v1";
  attempt_id: string;
  probe_id: string;
  provider: string;
  service_id: string;
  endpoint: string;
  status: PaymentAttemptStatus;
  quoted_amount_usdc: string | null;
  cap_usdc: string | null;
  payment_header_created: boolean;
  payment_header_sent: boolean;
  wallet_loaded: boolean;
  execute_paid_used: boolean;
  request_sent_at: string | null;
  response_received_at: string | null;
  settlement: SettlementEvidenceV1 | null;
  policy_flags: {
    no_payment_mode: boolean;
    paid_execution_armed: boolean;
    human_authorized: boolean;
  };
  safety: {
    secrets_printed: boolean;
    retry_used: boolean;
    fallback_used: boolean;
    payment_bearing_http_request_count: number;
  };
}

export type PaymentIntegrityStatus =
  | "pass"
  | "fail"
  | "blocked"
  | "not_applicable";

export interface PaymentIntegrityResultV1 {
  schema_version: "payment_integrity_result.v1";
  status: PaymentIntegrityStatus;
  pass: boolean;
  checked_at: string;
  reasons: string[];
  settlement_evidence_status: SettlementEvidenceStatus;
  semantic_evaluation_status: "pass" | "fail" | "not_executed" | "unknown";
  invariants: {
    no_trust_score_without_settlement: boolean;
    no_trust_score_without_semantic_pass: boolean;
    no_payment_header_in_no_payment_mode: boolean;
    no_wallet_load_in_no_payment_mode: boolean;
    no_retry_in_no_payment_mode: boolean;
    settlement_hash_matches_ledger: boolean | null;
  };
}

export interface BlockedTrustScoreResult {
  schema_version: "blocked_trust_score_result.v1";
  trust_score_created: false;
  blocked_reason:
    | "missing_payment_integrity_pass"
    | "missing_semantic_evaluation_pass"
    | "payment_integrity_fail"
    | "semantic_evaluation_fail"
    | "both_gates_failed";
  payment_integrity_status: PaymentIntegrityStatus | string;
  semantic_evaluation_status: string;
  checked_at: string;
}

const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function legacyToV1Status(
  legacy: LegacySettlementEvidence,
  quoteUsdc?: string | null,
): SettlementEvidenceStatus {
  if (legacy.status === "not_required") return "not_executed";
  if (legacy.status === "header_tx_hash_found" || legacy.status === "chain_reconciled") {
    return "pass";
  }
  if (
    legacy.status === "failed_verification" ||
    legacy.status === "no_settlement_found_onchain"
  ) {
    return "fail";
  }
  if (legacy.transactionHash && legacy.amountDecimal) {
    return "pass";
  }
  if (quoteUsdc && !legacy.transactionHash) {
    return "fail";
  }
  return "unknown";
}

export function settlementEvidenceToV1(input: {
  readonly legacy: LegacySettlementEvidence;
  readonly blockNumber?: number | null;
  readonly quoteUsdc?: string | null;
  readonly quoteChainId?: number | null;
  readonly quotePayee?: string | null;
  readonly evidenceSource?: SettlementEvidenceV1["evidence_source"];
  readonly reconciledAt?: string | null;
}): SettlementEvidenceV1 {
  const { legacy } = input;
  const missing: string[] = [];
  if (!legacy.payer) missing.push("payer");
  if (!legacy.payTo) missing.push("payee");
  if (!legacy.amountDecimal) missing.push("amount.human");

  const status = legacyToV1Status(legacy, input.quoteUsdc);
  const chainId = legacy.chainId ?? input.quoteChainId ?? null;

  return {
    schema_version: "settlement_evidence.v1",
    status,
    chain_id: chainId,
    network: chainId === 8453 ? "base" : chainId != null ? `eip155:${chainId}` : null,
    tx_hash: legacy.transactionHash,
    block_number: input.blockNumber ?? null,
    payer: legacy.payer,
    payee: legacy.payTo,
    token: {
      address: legacy.asset === "USDC" ? BASE_USDC : null,
      symbol: legacy.asset,
      decimals: legacy.asset === "USDC" ? 6 : null,
    },
    amount: {
      raw: legacy.amountAtomic,
      human: legacy.amountDecimal,
      currency: legacy.asset,
    },
    settlement_recipient_matches_quote:
      input.quotePayee && legacy.payTo
        ? input.quotePayee.toLowerCase() === legacy.payTo.toLowerCase()
        : null,
    settlement_amount_matches_quote:
      input.quoteUsdc && legacy.amountDecimal
        ? input.quoteUsdc === legacy.amountDecimal
        : null,
    settlement_chain_matches_quote:
      input.quoteChainId != null && chainId != null
        ? input.quoteChainId === chainId
        : null,
    confirmations: legacy.receiptStatus === "success" ? 1 : null,
    explorer_url: legacy.transactionHash
      ? `https://basescan.org/tx/${legacy.transactionHash}`
      : null,
    evidence_source: input.evidenceSource ?? "offline_replay",
    reconciled_at: input.reconciledAt ?? null,
    ...(status === "fail" ? { failure_reason: legacy.notes.join("; ") || legacy.status } : {}),
    ...(missing.length > 0 ? { missing_fields: missing } : {}),
  };
}

export function ledgerEntryToV1(
  entry: PaymentAttemptLedgerEntry,
  options: {
    readonly noPaymentMode?: boolean;
    readonly blockNumber?: number | null;
    readonly reconciledAt?: string | null;
  } = {},
): PaymentAttemptLedgerEntryV1 {
  const evidence =
    entry.chainReconciledSettlementEvidence ?? entry.savedSettlementEvidence;
  const settlement = settlementEvidenceToV1({
    legacy: evidence,
    blockNumber: options.blockNumber ?? null,
    quoteUsdc: entry.quoteUsdc,
    quoteChainId: 8453,
    quotePayee: evidence.payTo,
    evidenceSource: entry.chainReconciledSettlementEvidence
      ? "offline_replay"
      : "not_available",
    reconciledAt: options.reconciledAt ?? entry.createdAtUtc,
  });

  let status: PaymentAttemptStatus = "not_attempted";
  if (entry.paymentBearingHttpRequestCount === 0) {
    status = "quoted_unpaid";
  } else if (settlement.status === "pass") {
    status = "settlement_reconciled";
  } else if (entry.sellerResponseCaptured) {
    status = "seller_response_received";
  } else if (entry.paymentBearingHttpRequestCount > 0) {
    status = "payment_header_sent";
  }

  const noPayment = options.noPaymentMode ?? false;

  return {
    schema_version: "payment_attempt_ledger_entry.v1",
    attempt_id: entry.attemptId,
    probe_id: entry.runId,
    provider: "Zapper",
    service_id: entry.serviceId,
    endpoint: entry.endpoint,
    status,
    quoted_amount_usdc: entry.quoteUsdc,
    cap_usdc: entry.capUsdc,
    payment_header_created: entry.paymentBearingHttpRequestCount > 0,
    payment_header_sent: entry.paymentBearingHttpRequestCount > 0 && !noPayment,
    wallet_loaded: Boolean(entry.walletFingerprint) && !noPayment,
    execute_paid_used: entry.paymentBearingHttpRequestCount > 0 && !noPayment,
    request_sent_at: entry.createdAtUtc,
    response_received_at: entry.sellerResponseCaptured ? entry.createdAtUtc : null,
    settlement: settlement.tx_hash || settlement.status !== "not_executed" ? settlement : null,
    policy_flags: {
      no_payment_mode: noPayment,
      paid_execution_armed: !noPayment,
      human_authorized: !noPayment,
    },
    safety: {
      secrets_printed: false,
      retry_used: false,
      fallback_used: false,
      payment_bearing_http_request_count: noPayment
        ? 0
        : entry.paymentBearingHttpRequestCount,
    },
  };
}

export interface PaymentIntegrityEngineInput {
  readonly ledgerEntry: PaymentAttemptLedgerEntryV1;
  readonly semanticEvaluationStatus: "pass" | "fail" | "not_executed" | "unknown";
  readonly expectedSettlementHashes?: readonly string[];
  readonly checkedAt?: string;
}

export function runPaymentIntegrityEngine(
  input: PaymentIntegrityEngineInput,
): PaymentIntegrityResultV1 {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const reasons: string[] = [];
  const { ledgerEntry } = input;
  const noPayment = ledgerEntry.policy_flags.no_payment_mode;

  const settlementStatus: SettlementEvidenceStatus =
    ledgerEntry.settlement?.status ?? "not_executed";

  if (noPayment && ledgerEntry.payment_header_sent) {
    reasons.push("payment header sent in no-payment mode");
  }
  if (noPayment && ledgerEntry.wallet_loaded) {
    reasons.push("wallet loaded in no-payment mode");
  }
  if (noPayment && ledgerEntry.safety.retry_used) {
    reasons.push("retry used in no-payment mode");
  }
  if (noPayment && ledgerEntry.safety.payment_bearing_http_request_count > 0) {
    reasons.push("payment-bearing HTTP request in no-payment mode");
  }

  let settlementHashMatches: boolean | null = null;
  if (input.expectedSettlementHashes && ledgerEntry.settlement?.tx_hash) {
    settlementHashMatches = input.expectedSettlementHashes.some(
      (h) => h.toLowerCase() === ledgerEntry.settlement!.tx_hash!.toLowerCase(),
    );
    if (!settlementHashMatches) {
      reasons.push("settlement hash does not match expected ledger evidence");
    }
  }

  const semanticPass = input.semanticEvaluationStatus === "pass";
  const settlementPass = settlementStatus === "pass";

  if (!settlementPass) {
    reasons.push(`settlement evidence status: ${settlementStatus}`);
  }
  if (!semanticPass) {
    reasons.push(`semantic evaluation status: ${input.semanticEvaluationStatus}`);
  }

  let status: PaymentIntegrityStatus = "pass";
  if (noPayment && reasons.some((r) => r.includes("no-payment mode"))) {
    status = "blocked";
  } else if (!settlementPass && !semanticPass) {
    status = "fail";
  } else if (!settlementPass || !semanticPass) {
    status = "fail";
  } else if (settlementHashMatches === false) {
    status = "fail";
  }

  const pass = status === "pass";

  return {
    schema_version: "payment_integrity_result.v1",
    status,
    pass,
    checked_at: checkedAt,
    reasons,
    settlement_evidence_status: settlementStatus,
    semantic_evaluation_status: input.semanticEvaluationStatus,
    invariants: {
      no_trust_score_without_settlement: !pass || settlementPass,
      no_trust_score_without_semantic_pass: !pass || semanticPass,
      no_payment_header_in_no_payment_mode: !(
        noPayment && ledgerEntry.payment_header_sent
      ),
      no_wallet_load_in_no_payment_mode: !(noPayment && ledgerEntry.wallet_loaded),
      no_retry_in_no_payment_mode: !(noPayment && ledgerEntry.safety.retry_used),
      settlement_hash_matches_ledger: settlementHashMatches,
    },
  };
}

export interface TrustScoreGateInput {
  readonly paymentIntegrity: PaymentIntegrityResultV1;
  readonly semanticEvaluationStatus: "pass" | "fail" | "not_executed" | "unknown";
  readonly checkedAt?: string;
}

export type TrustScoreGateResult =
  | { readonly trust_score_created: true }
  | BlockedTrustScoreResult;

export function evaluateTrustScoreCreation(
  input: TrustScoreGateInput,
): TrustScoreGateResult {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const paymentPass = input.paymentIntegrity.pass && input.paymentIntegrity.status === "pass";
  const semanticPass = input.semanticEvaluationStatus === "pass";

  if (paymentPass && semanticPass) {
    return { trust_score_created: true };
  }

  let blockedReason: BlockedTrustScoreResult["blocked_reason"];
  if (!paymentPass && !semanticPass) {
    blockedReason = "both_gates_failed";
  } else if (!paymentPass) {
    blockedReason =
      input.paymentIntegrity.status === "fail"
        ? "payment_integrity_fail"
        : "missing_payment_integrity_pass";
  } else {
    blockedReason =
      input.semanticEvaluationStatus === "fail"
        ? "semantic_evaluation_fail"
        : "missing_semantic_evaluation_pass";
  }

  return {
    schema_version: "blocked_trust_score_result.v1",
    trust_score_created: false,
    blocked_reason: blockedReason,
    payment_integrity_status: input.paymentIntegrity.status,
    semantic_evaluation_status: input.semanticEvaluationStatus,
    checked_at: checkedAt,
  };
}
