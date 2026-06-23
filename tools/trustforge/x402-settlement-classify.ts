/**
 * x402-settlement-classify — network-parameterized reconcile + three-outcome classify.
 */

import type { SanitizedFacilitatorReceipt } from "./facilitator-settlement-receipt";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import {
  bindingConfirmsSettlement,
  confirmSettlementBinding,
  countIdentifiedSettlements,
  type OnChainSettlementRow,
  type SettlementBindingRecord,
  type SettlementIntent,
} from "./settlement-run-binding";
import {
  classifyThinSettlementOutcome,
  detailForThinSettlementOutcome,
  type FacilitatorReceiptParseStatus,
} from "./thin-settlement-outcome";
import type { PaidProbeOutcome } from "./paid-probe-outcome";
import type { X402SettlementProfile } from "./x402-settlement-profile";
import { SEPOLIA_X402_SETTLEMENT_PROFILE } from "./x402-settlement-profile";

export interface X402SettlementProbeRecord {
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly httpStatus: number | null;
  readonly balanceBeforeUsdc?: string;
  readonly settlementTxHash?: string | null;
  readonly onChainConfirmed?: boolean;
  readonly facilitatorReceiptParseStatus?: FacilitatorReceiptParseStatus | null;
  readonly facilitatorReceiptPresent?: boolean;
}

export interface SettlementBindingMetrics {
  readonly total_outflow_settlements_found: number;
  readonly known_settlements_confirmed_onchain: number;
  readonly phase6_settlements_identified: number;
  readonly unattributed_settlements_found: number;
  readonly current_attempt_id: string | null;
  readonly current_attempt_candidates_after_filter: number;
  readonly current_attempt_settlement_block: number | null;
  readonly current_attempt_settlement_tx_hash: string | null;
}

export interface X402ClassificationResult {
  readonly outcome: PaidProbeOutcome;
  readonly reconciliationStatus: string | null;
  readonly safeToUseForPaymentVerification: boolean;
  readonly unattributedSettlementsFound: number | null;
  readonly balanceIdentityStatus: string | null;
  readonly settlementTxHash: string | null;
  readonly detail: string;
  readonly binding?: SettlementBindingRecord | null;
  readonly bindingMetrics?: SettlementBindingMetrics | null;
}

export function ledgerSettlementsToRows(
  ledger: Record<string, unknown>,
): readonly OnChainSettlementRow[] {
  const settlements = Array.isArray(ledger.settlements) ? ledger.settlements : [];
  return settlements
    .filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    .map((row) => ({
      tx_hash: String(row.tx_hash ?? ""),
      to: String(row.to ?? ""),
      value_atomic: String(row.value_atomic ?? row.amount_atomic ?? ""),
      value_usdc: row.value_usdc !== undefined ? String(row.value_usdc) : undefined,
      block_number:
        typeof row.block_number === "number"
          ? row.block_number
          : Number.parseInt(String(row.block_number ?? ""), 10) || undefined,
      timestamp_utc:
        row.timestamp_utc === null || row.timestamp_utc === undefined
          ? null
          : String(row.timestamp_utc),
      matched_run: row.matched_run === null || row.matched_run === undefined ? null : String(row.matched_run),
    }))
    .filter((row) => row.tx_hash.length > 0);
}

export function buildSettlementBindingMetrics(input: {
  readonly ledger: Record<string, unknown>;
  readonly binding: SettlementBindingRecord | null;
}): SettlementBindingMetrics {
  const settlements = ledgerSettlementsToRows(input.ledger);
  const outflowCount = settlements.length;
  const identified = input.binding ? countIdentifiedSettlements(settlements, input.binding) : 0;
  const bindingConfirmed = input.binding ? bindingConfirmsSettlement(input.binding) : false;
  const unattributed =
    input.ledger.unattributed_settlements_found === null ||
    input.ledger.unattributed_settlements_found === undefined
      ? settlements.filter((row) => !row.matched_run).length
      : Number(input.ledger.unattributed_settlements_found);
  return {
    total_outflow_settlements_found: outflowCount,
    known_settlements_confirmed_onchain: bindingConfirmed ? 1 : 0,
    phase6_settlements_identified: identified,
    unattributed_settlements_found: unattributed,
    current_attempt_id: input.binding?.attempt_id ?? null,
    current_attempt_candidates_after_filter: input.binding?.current_attempt_candidates_after_filter ?? 0,
    current_attempt_settlement_block:
      input.binding?.independent_match?.block_number ??
      (input.binding?.block_number ? Number.parseInt(input.binding.block_number, 10) : null),
    current_attempt_settlement_tx_hash:
      input.binding?.independent_match?.settlement_tx_hash ??
      input.binding?.settlement_tx_hash ??
      null,
  };
}

export function confirmX402SettlementBinding(input: {
  readonly intent: SettlementIntent;
  readonly ledger: Record<string, unknown>;
  readonly facilitatorReceipt?: SanitizedFacilitatorReceipt | null;
  readonly facilitatorReportedHash?: string | null;
  readonly upperBoundUtc: string;
}): { readonly binding: SettlementBindingRecord; readonly metrics: SettlementBindingMetrics } {
  const settlements = ledgerSettlementsToRows(input.ledger);
  const binding = confirmSettlementBinding({
    intent: input.intent,
    settlements,
    facilitatorReceipt: input.facilitatorReceipt,
    facilitatorReportedHash: input.facilitatorReportedHash,
    upperBoundUtc: input.upperBoundUtc,
  });
  const metrics = buildSettlementBindingMetrics({ ledger: input.ledger, binding });
  return { binding, metrics };
}

export function parseReconciliationLedger(
  json: Record<string, unknown>,
  profile?: X402SettlementProfile,
): {
  reconciliationStatus: string;
  safeToUseForPaymentVerification: boolean;
  unattributedSettlementsFound: number | null;
  balanceIdentityStatus: string;
  settlementTxHash: string | null;
  rpcUnavailable: boolean;
  noNewOutboundTransfer: boolean;
} {
  const reconciliationStatus = String(json.reconciliation_status ?? "unknown");
  const rpcUnavailable = reconciliationStatus.startsWith("RECONCILIATION_RPC");
  const settlements = Array.isArray(json.settlements) ? json.settlements : [];
  const label = profile?.matchedRunLabel ?? "thin_settlement_proof";
  const proof = settlements.find(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      ((row as { matched_run?: string }).matched_run === label ||
        (row as { matched_run?: string }).matched_run === "Sepolia_settlement_proof"),
  ) as { tx_hash?: string } | undefined;
  const balanceIdentityStatus = String(json.balance_identity_status ?? "not_run");
  return {
    reconciliationStatus,
    safeToUseForPaymentVerification: Boolean(json.safe_to_use_for_payment_verification),
    unattributedSettlementsFound:
      json.unattributed_settlements_found === null ||
      json.unattributed_settlements_found === undefined
        ? null
        : Number(json.unattributed_settlements_found),
    balanceIdentityStatus,
    settlementTxHash: proof?.tx_hash ?? null,
    rpcUnavailable,
    noNewOutboundTransfer: reconciliationStatus !== "RECONCILIATION_PASS" || !proof?.tx_hash,
  };
}

export function inferNoNewOutboundTransfer(input: {
  readonly parsed: ReturnType<typeof parseReconciliationLedger>;
  readonly binding: SettlementBindingRecord | null;
  readonly paymentAttempted: boolean;
  readonly quoteAtomic: string;
}): boolean {
  if (input.binding && bindingConfirmsSettlement(input.binding)) {
    return false;
  }
  if (input.binding?.independent_match?.settlement_tx_hash) {
    return false;
  }
  if (input.parsed.balanceIdentityStatus !== "pass") {
    return false;
  }
  return true;
}

export function buildX402ReconcileArgs(
  profile: X402SettlementProfile,
  selected: DiscoveredSelectedCandidate,
  balanceBeforeUsdc?: string,
  rpcOptions?: {
    readonly rpcRequestTimeoutSeconds?: number;
    readonly rpcMaxRetries?: number;
    readonly maxTotalRuntimeSeconds?: number;
  },
): string[] {
  const args = [
    "--network",
    profile.reconcileCliNetwork,
    "--expected-pay-to",
    selected.authorized_pay_to,
    "--expected-amount-usdc",
    selected.quote_amount_usdc,
    "--expected-amount-atomic",
    selected.quote_atomic,
  ];
  if (balanceBeforeUsdc) {
    args.push("--balance-before-usdc", balanceBeforeUsdc);
  }
  if (rpcOptions?.rpcRequestTimeoutSeconds !== undefined) {
    args.push("--rpc-request-timeout-seconds", String(rpcOptions.rpcRequestTimeoutSeconds));
  }
  if (rpcOptions?.rpcMaxRetries !== undefined) {
    args.push("--rpc-max-retries", String(rpcOptions.rpcMaxRetries));
  }
  if (rpcOptions?.maxTotalRuntimeSeconds !== undefined) {
    args.push("--max-total-runtime-seconds", String(rpcOptions.maxTotalRuntimeSeconds));
  }
  return args;
}

export function classifyX402Settlement(input: {
  readonly probe: X402SettlementProbeRecord;
  readonly reconciliationUnavailable?: boolean;
  readonly reconciliationStatus?: string | null;
  readonly safeToUseForPaymentVerification?: boolean;
  readonly unattributedSettlementsFound?: number | null;
  readonly balanceIdentityStatus?: string | null;
  readonly noNewOutboundTransfer?: boolean;
  readonly binding?: SettlementBindingRecord | null;
  readonly bindingMetrics?: SettlementBindingMetrics | null;
  readonly invariantsOk?: boolean;
}): X402ClassificationResult {
  const bindingConfirmed = input.binding ? bindingConfirmsSettlement(input.binding) : false;
  const bindingIndependentMatch = Boolean(input.binding?.independent_match?.settlement_tx_hash);
  const balanceIdentityPass = input.balanceIdentityStatus === "pass";

  const onChainConfirmed = Boolean(
    input.probe.onChainConfirmed ?? (bindingConfirmed && input.safeToUseForPaymentVerification),
  );

  const outcome = classifyThinSettlementOutcome({
    httpStatus: input.probe.httpStatus,
    paymentAttempted: input.probe.paymentAttempted,
    paymentBearingHttpRequestCount: input.probe.paymentBearingHttpRequestCount,
    facilitatorReceiptParseStatus: input.probe.facilitatorReceiptParseStatus ?? null,
    facilitatorReceiptPresent: Boolean(input.probe.facilitatorReceiptPresent),
    onChainBindingConfirmed: onChainConfirmed,
    balanceIdentityPass,
    noNewOutboundTransfer: input.noNewOutboundTransfer ?? false,
    reconciliationUnavailable: input.reconciliationUnavailable ?? false,
    reconciliationStatus: input.reconciliationStatus ?? null,
    binding: input.binding ?? null,
    invariantsOk: input.invariantsOk ?? true,
  });

  const settlementTxHash =
    bindingConfirmed || bindingIndependentMatch
      ? (input.binding?.settlement_tx_hash ?? input.probe.settlementTxHash ?? null)
      : (input.binding?.settlement_tx_hash ?? null);

  return {
    outcome,
    reconciliationStatus: input.reconciliationStatus ?? null,
    safeToUseForPaymentVerification: input.safeToUseForPaymentVerification ?? false,
    unattributedSettlementsFound: input.unattributedSettlementsFound ?? null,
    balanceIdentityStatus: input.balanceIdentityStatus ?? null,
    settlementTxHash,
    detail: detailForThinSettlementOutcome(outcome),
    binding: input.binding ?? null,
    bindingMetrics: input.bindingMetrics ?? null,
  };
}

// Backward-compatible Sepolia aliases
export type SepoliaSettlementProbeRecord = X402SettlementProbeRecord;
export type SepoliaClassificationResult = X402ClassificationResult;

export const classifySepoliaSettlement = classifyX402Settlement;
export const confirmSepoliaSettlementBinding = confirmX402SettlementBinding;
export const buildSepoliaReconcileArgs = (
  selected: DiscoveredSelectedCandidate,
  balanceBeforeUsdc?: string,
  rpcOptions?: Parameters<typeof buildX402ReconcileArgs>[3],
): string[] => buildX402ReconcileArgs(SEPOLIA_X402_SETTLEMENT_PROFILE, selected, balanceBeforeUsdc, rpcOptions);
