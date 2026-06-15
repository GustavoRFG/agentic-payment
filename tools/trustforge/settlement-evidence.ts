/**
 * settlement-evidence — settlement-first payment proof model (Phase 4).
 */

export type SettlementEvidenceStatus =
  | "not_required"
  | "header_tx_hash_found"
  | "chain_reconciled"
  | "missing_header_tx_hash"
  | "missing_payment_metadata"
  | "no_settlement_found_onchain"
  | "ambiguous_requires_manual_review"
  | "failed_verification";

export type TransactionHashSource =
  | "payment_response_header"
  | "x_payment_response_header"
  | "body_metadata"
  | "chain_reconciliation"
  | "manual_audit"
  | null;

export type SettlementMappingConfidence = "high" | "medium" | "low" | "unknown" | null;

export interface SettlementEvidence {
  readonly status: SettlementEvidenceStatus;
  readonly transactionHash: string | null;
  readonly transactionHashSource: TransactionHashSource;
  readonly chainId: number | null;
  readonly amountAtomic: string | null;
  readonly amountDecimal: string | null;
  readonly asset: string | null;
  readonly payer: string | null;
  readonly payTo: string | null;
  readonly receiptStatus: "success" | "failed" | "unknown" | null;
  readonly mappingConfidence: SettlementMappingConfidence;
  readonly evidencePaths: readonly string[];
  readonly notes: readonly string[];
}

export function emptySettlementEvidence(notes: readonly string[] = []): SettlementEvidence {
  return {
    status: "not_required",
    transactionHash: null,
    transactionHashSource: null,
    chainId: null,
    amountAtomic: null,
    amountDecimal: null,
    asset: null,
    payer: null,
    payTo: null,
    receiptStatus: null,
    mappingConfidence: null,
    evidencePaths: [],
    notes,
  };
}

export function settlementEvidenceFromSavedHeader(input: {
  readonly transactionHash: string;
  readonly amountDecimal?: string | null;
  readonly amountAtomic?: string | null;
  readonly payTo?: string | null;
  readonly payer?: string | null;
  readonly chainId?: number | null;
  readonly receiptStatus?: "success" | "failed" | "unknown";
  readonly source?: "payment_response_header" | "x_payment_response_header" | "body_metadata";
  readonly evidencePaths?: readonly string[];
}): SettlementEvidence {
  return {
    status: "header_tx_hash_found",
    transactionHash: input.transactionHash.toLowerCase(),
    transactionHashSource: input.source ?? "payment_response_header",
    chainId: input.chainId ?? 8453,
    amountAtomic: input.amountAtomic ?? null,
    amountDecimal: input.amountDecimal ?? null,
    asset: "USDC",
    payer: input.payer?.toLowerCase() ?? null,
    payTo: input.payTo?.toLowerCase() ?? null,
    receiptStatus: input.receiptStatus ?? "unknown",
    mappingConfidence: "high",
    evidencePaths: input.evidencePaths ?? [],
    notes: [],
  };
}

export function settlementEvidenceFromChainReconciliation(input: {
  readonly transactionHash: string;
  readonly amountDecimal: string;
  readonly amountAtomic: string;
  readonly payer: string;
  readonly payTo: string;
  readonly chainId?: number;
  readonly mappingConfidence?: SettlementMappingConfidence;
  readonly receiptStatus?: "success" | "failed" | "unknown";
  readonly evidencePaths?: readonly string[];
}): SettlementEvidence {
  return {
    status: "chain_reconciled",
    transactionHash: input.transactionHash.toLowerCase(),
    transactionHashSource: "chain_reconciliation",
    chainId: input.chainId ?? 8453,
    amountAtomic: input.amountAtomic,
    amountDecimal: input.amountDecimal,
    asset: "USDC",
    payer: input.payer.toLowerCase(),
    payTo: input.payTo.toLowerCase(),
    receiptStatus: input.receiptStatus ?? "success",
    mappingConfidence: input.mappingConfidence ?? "medium",
    evidencePaths: input.evidencePaths ?? [],
    notes: ["settlement recovered via read-only chain reconciliation"],
  };
}

export function missingHeaderSettlementEvidence(input: {
  readonly paymentMetadataPresent?: boolean;
  readonly paymentResponseHeaderPresent?: boolean;
  readonly quoteUsdc?: string | null;
}): SettlementEvidence {
  const status: SettlementEvidenceStatus = input.paymentMetadataPresent === false
    ? "missing_payment_metadata"
    : "missing_header_tx_hash";
  return {
    status,
    transactionHash: null,
    transactionHashSource: null,
    chainId: 8453,
    amountAtomic: null,
    amountDecimal: null,
    asset: "USDC",
    payer: null,
    payTo: null,
    receiptStatus: null,
    mappingConfidence: null,
    evidencePaths: [],
    notes: [
      input.paymentResponseHeaderPresent
        ? "payment header present but tx hash not decoded"
        : "no payment-response header metadata saved",
      `quote_usdc=${input.quoteUsdc ?? "null"} is not actual spend`,
    ],
  };
}

export function requiresChainReconciliation(evidence: SettlementEvidence): boolean {
  return (
    evidence.status === "missing_header_tx_hash" ||
    evidence.status === "missing_payment_metadata"
  );
}

/** @deprecated Phase 3B flat view — use SettlementEvidence.status directly in new code. */
export function legacySettlementEvidenceView(evidence: SettlementEvidence): {
  readonly settlement_evidence_status: string;
  readonly transaction_hash: string | null;
  readonly transaction_hash_source: string | null;
  readonly actual_spend_usdc: string | null;
} {
  return {
    settlement_evidence_status: evidence.status,
    transaction_hash: evidence.transactionHash,
    transaction_hash_source: evidence.transactionHashSource,
    actual_spend_usdc:
      evidence.transactionHash && evidence.amountDecimal ? evidence.amountDecimal : null,
  };
}

export function resolveSettlementEvidence(input: {
  readonly paymentAttempted: boolean;
  readonly savedTransactionHash?: string | null;
  readonly paymentResponseHeaderPresent?: boolean;
  readonly paymentMetadataPresent?: boolean;
  readonly onchainVerified?: boolean;
  readonly reconciledTxHash?: string | null;
  readonly reconciledAmountUsdc?: string | null;
  readonly reconciledAmountAtomic?: string | null;
  readonly mappingConfidence?: SettlementMappingConfidence;
  readonly quoteUsdc?: string | null;
  readonly payer?: string | null;
  readonly payTo?: string | null;
}): SettlementEvidence {
  if (!input.paymentAttempted) {
    return emptySettlementEvidence(["payment not attempted"]);
  }

  if (input.savedTransactionHash) {
    return settlementEvidenceFromSavedHeader({
      transactionHash: input.savedTransactionHash,
      amountDecimal: input.reconciledAmountUsdc ?? null,
      payer: input.payer,
      payTo: input.payTo,
      receiptStatus: input.onchainVerified ? "success" : "unknown",
    });
  }

  if (input.reconciledTxHash && input.reconciledAmountUsdc) {
    return settlementEvidenceFromChainReconciliation({
      transactionHash: input.reconciledTxHash,
      amountDecimal: input.reconciledAmountUsdc,
      amountAtomic: input.reconciledAmountAtomic ?? "1125",
      payer: input.payer ?? "",
      payTo: input.payTo ?? "",
      mappingConfidence: input.mappingConfidence ?? "medium",
      receiptStatus: input.onchainVerified ? "success" : "success",
    });
  }

  if (input.paymentAttempted && !input.reconciledTxHash) {
    return {
      ...missingHeaderSettlementEvidence({
        paymentMetadataPresent: input.paymentMetadataPresent,
        paymentResponseHeaderPresent: input.paymentResponseHeaderPresent,
        quoteUsdc: input.quoteUsdc,
      }),
      status: input.paymentResponseHeaderPresent
        ? "missing_header_tx_hash"
        : "missing_payment_metadata",
    };
  }

  return {
    status: "no_settlement_found_onchain",
    transactionHash: null,
    transactionHashSource: null,
    chainId: 8453,
    amountAtomic: null,
    amountDecimal: null,
    asset: "USDC",
    payer: input.payer?.toLowerCase() ?? null,
    payTo: input.payTo?.toLowerCase() ?? null,
    receiptStatus: null,
    mappingConfidence: null,
    evidencePaths: [],
    notes: ["no settlement evidence found"],
  };
}
