/**
 * payment-integrity-engine — settlement-first payment integrity evaluation.
 */

import type { PaymentAttemptLedgerEntry, PaymentIntegrityOutcome } from "./payment-attempt-ledger";
import type { SettlementEvidence, SettlementMappingConfidence } from "./settlement-evidence";
import { requiresChainReconciliation } from "./settlement-evidence";

export interface PaymentIntegrityResult {
  readonly status: PaymentIntegrityOutcome;
  readonly actualSpendUsdc: string | null;
  readonly transactionHash: string | null;
  readonly transactionHashSource: SettlementEvidence["transactionHashSource"];
  readonly settlementEvidenceStatus: SettlementEvidence["status"];
  readonly mappingConfidence: SettlementMappingConfidence;
  readonly blockReasons: readonly string[];
  readonly onchainReconciliationRequired: boolean;
  readonly onchainReconciliationAttempted: boolean;
}

function amountsMatch(quote: string | null, actual: string | null): boolean {
  if (!quote || !actual) return false;
  const normalize = (value: string) => value.replace(/^0+/, "") || "0";
  const [qw, qf = ""] = quote.split(".");
  const [aw, af = ""] = actual.split(".");
  return normalize(qw) === normalize(aw) && (qf + "000000").slice(0, 6) === (af + "000000").slice(0, 6);
}

function pickFinalEvidence(entry: PaymentAttemptLedgerEntry): SettlementEvidence {
  return entry.chainReconciledSettlementEvidence ?? entry.savedSettlementEvidence;
}

export function evaluatePaymentIntegrity(input: {
  readonly entry: PaymentAttemptLedgerEntry;
  readonly chainReconciliationAttempted?: boolean;
}): PaymentIntegrityResult {
  const { entry } = input;
  const blockReasons: string[] = [];
  const reconciliationAttempted = input.chainReconciliationAttempted ?? Boolean(
    entry.chainReconciledSettlementEvidence,
  );
  const onchainReconciliationRequired =
    entry.paymentBearingHttpRequestCount > 0 &&
    requiresChainReconciliation(entry.savedSettlementEvidence);

  if (entry.paymentBearingHttpRequestCount === 0) {
    return {
      status: "not_executed",
      actualSpendUsdc: null,
      transactionHash: null,
      transactionHashSource: null,
      settlementEvidenceStatus: "not_required",
      mappingConfidence: null,
      blockReasons: [],
      onchainReconciliationRequired: false,
      onchainReconciliationAttempted: false,
    };
  }

  const evidence = pickFinalEvidence(entry);

  if (evidence.receiptStatus === "failed") {
    blockReasons.push("receipt failed");
    return {
      status: "fail",
      actualSpendUsdc: null,
      transactionHash: evidence.transactionHash,
      transactionHashSource: evidence.transactionHashSource,
      settlementEvidenceStatus: "failed_verification",
      mappingConfidence: evidence.mappingConfidence,
      blockReasons,
      onchainReconciliationRequired,
      onchainReconciliationAttempted: reconciliationAttempted,
    };
  }

  if (
    onchainReconciliationRequired &&
    !reconciliationAttempted &&
    !evidence.transactionHash
  ) {
    blockReasons.push("missing tx hash requires chain reconciliation");
    return {
      status: "ambiguous",
      actualSpendUsdc: null,
      transactionHash: null,
      transactionHashSource: null,
      settlementEvidenceStatus: evidence.status,
      mappingConfidence: null,
      blockReasons,
      onchainReconciliationRequired: true,
      onchainReconciliationAttempted: false,
    };
  }

  if (!evidence.transactionHash) {
    blockReasons.push("no settlement found onchain");
    return {
      status: "fail",
      actualSpendUsdc: null,
      transactionHash: null,
      transactionHashSource: null,
      settlementEvidenceStatus: evidence.status === "missing_header_tx_hash"
        ? "no_settlement_found_onchain"
        : evidence.status,
      mappingConfidence: evidence.mappingConfidence,
      blockReasons,
      onchainReconciliationRequired,
      onchainReconciliationAttempted: reconciliationAttempted,
    };
  }

  if (
    evidence.status === "ambiguous_requires_manual_review" ||
    evidence.mappingConfidence === "low" ||
    evidence.mappingConfidence === "unknown"
  ) {
    blockReasons.push("settlement mapping confidence too low");
    return {
      status: "ambiguous",
      actualSpendUsdc: entry.actualSpendUsdc,
      transactionHash: evidence.transactionHash,
      transactionHashSource: evidence.transactionHashSource,
      settlementEvidenceStatus: "ambiguous_requires_manual_review",
      mappingConfidence: evidence.mappingConfidence,
      blockReasons,
      onchainReconciliationRequired,
      onchainReconciliationAttempted: reconciliationAttempted,
    };
  }

  const actualSpend = entry.actualSpendUsdc ?? evidence.amountDecimal;
  if (actualSpend && entry.quoteUsdc && !amountsMatch(entry.quoteUsdc, actualSpend)) {
    blockReasons.push("amount mismatch vs quote");
    return {
      status: "fail",
      actualSpendUsdc: null,
      transactionHash: evidence.transactionHash,
      transactionHashSource: evidence.transactionHashSource,
      settlementEvidenceStatus: "failed_verification",
      mappingConfidence: evidence.mappingConfidence,
      blockReasons,
      onchainReconciliationRequired,
      onchainReconciliationAttempted: reconciliationAttempted,
    };
  }

  const passableStatuses: SettlementEvidence["status"][] = [
    "header_tx_hash_found",
    "chain_reconciled",
  ];
  if (!passableStatuses.includes(evidence.status)) {
    blockReasons.push(`settlement status ${evidence.status} is not passable`);
    return {
      status: "ambiguous",
      actualSpendUsdc: actualSpend,
      transactionHash: evidence.transactionHash,
      transactionHashSource: evidence.transactionHashSource,
      settlementEvidenceStatus: evidence.status,
      mappingConfidence: evidence.mappingConfidence,
      blockReasons,
      onchainReconciliationRequired,
      onchainReconciliationAttempted: reconciliationAttempted,
    };
  }

  return {
    status: "pass",
    actualSpendUsdc: actualSpend,
    transactionHash: evidence.transactionHash,
    transactionHashSource: evidence.transactionHashSource,
    settlementEvidenceStatus: evidence.status,
    mappingConfidence: evidence.mappingConfidence,
    blockReasons: [],
    onchainReconciliationRequired,
    onchainReconciliationAttempted: reconciliationAttempted,
  };
}

export function applyPaymentIntegrityToEntry(
  entry: PaymentAttemptLedgerEntry,
  options: { readonly chainReconciliationAttempted?: boolean } = {},
): PaymentAttemptLedgerEntry {
  const result = evaluatePaymentIntegrity({
    entry,
    chainReconciliationAttempted: options.chainReconciliationAttempted,
  });
  return {
    ...entry,
    finalPaymentIntegrity: result.status,
    actualSpendUsdc: result.actualSpendUsdc,
    actualSpendSource:
      result.transactionHashSource === "chain_reconciliation"
        ? "chain_reconciliation"
        : result.transactionHashSource
          ? "saved_header"
          : null,
  };
}
