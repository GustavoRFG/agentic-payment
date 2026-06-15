/**
 * settlement-evidence — persisted / reconciled payment settlement model.
 */

export type SavedSettlementEvidenceStatus =
  | "header_tx_hash_found"
  | "no_header_tx_hash"
  | "missing_payment_metadata";

export type OnchainReconciliationStatus =
  | "found"
  | "not_found"
  | "ambiguous"
  | "not_executed";

export type SettlementEvidenceStatus =
  | "header_verified"
  | "reconciled_from_chain"
  | "no_settlement_found"
  | "ambiguous"
  | "missing_metadata"
  | "onchain_verified"
  | "no_payment_header"
  | "not_executed";

export type TransactionHashSource = "saved_payment_header" | "chain_reconciliation" | null;

export type SettlementMappingConfidence = "high" | "medium" | "low" | "unknown" | null;

export interface SettlementEvidence {
  readonly saved_settlement_evidence_status: SavedSettlementEvidenceStatus;
  readonly onchain_reconciliation_status: OnchainReconciliationStatus;
  readonly settlement_evidence_status: SettlementEvidenceStatus;
  readonly transaction_hash: string | null;
  readonly transaction_hash_source: TransactionHashSource;
  readonly settlement_mapping_confidence: SettlementMappingConfidence;
  readonly actual_spend_usdc: string | null;
  readonly quote_usdc: string | null;
  readonly payment_response_header_present: boolean;
  readonly payment_response_header_sha256: string | null;
  readonly reconciled_tx_hashes: readonly string[];
}

export function resolveSettlementEvidence(input: {
  readonly paymentAttempted: boolean;
  readonly savedTransactionHash?: string | null;
  readonly paymentResponseHeaderPresent?: boolean;
  readonly paymentMetadataPresent?: boolean;
  readonly onchainVerified?: boolean;
  readonly reconciledTxHash?: string | null;
  readonly reconciledAmountUsdc?: string | null;
  readonly mappingConfidence?: SettlementMappingConfidence;
  readonly quoteUsdc?: string | null;
}): SettlementEvidence {
  if (!input.paymentAttempted) {
    return {
      saved_settlement_evidence_status: "missing_payment_metadata",
      onchain_reconciliation_status: "not_executed",
      settlement_evidence_status: "not_executed",
      transaction_hash: null,
      transaction_hash_source: null,
      settlement_mapping_confidence: null,
      actual_spend_usdc: null,
      quote_usdc: input.quoteUsdc ?? null,
      payment_response_header_present: false,
      payment_response_header_sha256: null,
      reconciled_tx_hashes: [],
    };
  }

  const savedStatus: SavedSettlementEvidenceStatus = input.savedTransactionHash
    ? "header_tx_hash_found"
    : input.paymentResponseHeaderPresent
      ? "no_header_tx_hash"
      : input.paymentMetadataPresent === false
        ? "missing_payment_metadata"
        : "no_header_tx_hash";

  let onchainReconciliation: OnchainReconciliationStatus = "not_executed";
  if (input.reconciledTxHash) {
    onchainReconciliation =
      input.mappingConfidence === "low" || input.mappingConfidence === "unknown"
        ? "ambiguous"
        : "found";
  } else if (input.paymentAttempted) {
    onchainReconciliation = "not_found";
  }

  let settlementStatus: SettlementEvidenceStatus = "missing_metadata";
  if (input.onchainVerified && input.savedTransactionHash) {
    settlementStatus = "header_verified";
  } else if (input.onchainVerified) {
    settlementStatus = "onchain_verified";
  } else if (input.reconciledTxHash && onchainReconciliation === "found") {
    settlementStatus = "reconciled_from_chain";
  } else if (input.reconciledTxHash && onchainReconciliation === "ambiguous") {
    settlementStatus = "ambiguous";
  } else if (!input.paymentResponseHeaderPresent && savedStatus === "no_header_tx_hash") {
    settlementStatus = "no_payment_header";
  } else if (onchainReconciliation === "not_found") {
    settlementStatus = "no_settlement_found";
  }

  let transactionHash: string | null = input.savedTransactionHash ?? null;
  let transactionHashSource: TransactionHashSource = input.savedTransactionHash
    ? "saved_payment_header"
    : null;
  if (!transactionHash && input.reconciledTxHash) {
    transactionHash = input.reconciledTxHash;
    transactionHashSource = "chain_reconciliation";
  }

  const mappingConfidence = input.mappingConfidence ?? null;
  let actualSpend: string | null = null;
  if (input.onchainVerified && input.reconciledAmountUsdc) {
    actualSpend = input.reconciledAmountUsdc;
  } else if (
    transactionHashSource === "chain_reconciliation" &&
    input.reconciledAmountUsdc &&
    (mappingConfidence === "high" || mappingConfidence === "medium")
  ) {
    actualSpend = input.reconciledAmountUsdc;
  }

  return {
    saved_settlement_evidence_status: savedStatus,
    onchain_reconciliation_status: onchainReconciliation,
    settlement_evidence_status: settlementStatus,
    transaction_hash: transactionHash,
    transaction_hash_source: transactionHashSource,
    settlement_mapping_confidence: mappingConfidence,
    actual_spend_usdc: actualSpend,
    quote_usdc: input.quoteUsdc ?? null,
    payment_response_header_present: input.paymentResponseHeaderPresent ?? false,
    payment_response_header_sha256: null,
    reconciled_tx_hashes: input.reconciledTxHash ? [input.reconciledTxHash] : [],
  };
}
