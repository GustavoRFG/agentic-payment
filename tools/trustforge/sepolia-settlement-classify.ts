/**
 * sepolia-settlement-classify — reconcile Sepolia ledger + three-outcome classifier.
 */

import { classifyPaidProbeOutcome, type PaidProbeOutcome } from "./paid-probe-outcome";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import {
  bindingConfirmsSettlement,
  confirmSettlementBinding,
  countIdentifiedSettlements,
  type OnChainSettlementRow,
  type SettlementBindingRecord,
  type SettlementIntent,
} from "./settlement-run-binding";

export interface SepoliaSettlementProbeRecord {
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly httpStatus: number | null;
  readonly balanceBeforeUsdc?: string;
  readonly settlementTxHash?: string | null;
  readonly onChainConfirmed?: boolean;
}

export interface SepoliaClassificationResult {
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

export interface SettlementBindingMetrics {
  readonly total_outflow_settlements_found: number;
  readonly known_settlements_confirmed_onchain: number;
  readonly phase6_settlements_identified: number;
  readonly unattributed_settlements_found: number;
}

export function classifySepoliaSettlement(input: {
  readonly probe: SepoliaSettlementProbeRecord;
  readonly reconciliationUnavailable?: boolean;
  readonly reconciliationStatus?: string | null;
  readonly safeToUseForPaymentVerification?: boolean;
  readonly unattributedSettlementsFound?: number | null;
  readonly balanceIdentityStatus?: string | null;
  readonly settlementTxHash?: string | null;
  readonly invariantsOk?: boolean;
  readonly binding?: SettlementBindingRecord | null;
  readonly bindingMetrics?: SettlementBindingMetrics | null;
}): SepoliaClassificationResult {
  const onChainConfirmed = Boolean(
    input.probe.onChainConfirmed ??
      (input.settlementTxHash && input.safeToUseForPaymentVerification),
  );
  const outcome = classifyPaidProbeOutcome({
    paymentAttempted: input.probe.paymentAttempted,
    onChainConfirmed,
    paymentBearingHttpRequestCount: input.probe.paymentBearingHttpRequestCount,
    reconciliationUnavailable: input.reconciliationUnavailable,
    invariantsOk: input.invariantsOk ?? true,
  });

  return {
    outcome,
    reconciliationStatus: input.reconciliationStatus ?? null,
    safeToUseForPaymentVerification: input.safeToUseForPaymentVerification ?? false,
    unattributedSettlementsFound: input.unattributedSettlementsFound ?? null,
    balanceIdentityStatus: input.balanceIdentityStatus ?? null,
    settlementTxHash: input.settlementTxHash ?? input.probe.settlementTxHash ?? null,
    detail:
      outcome === "PASS_SETTLED"
        ? "Sepolia settlement proof complete"
        : outcome === "PASS_NO_SETTLE_CLEAN"
          ? "No payment attempted — happy path not proven"
          : `classified ${outcome}`,
    binding: input.binding ?? null,
    bindingMetrics: input.bindingMetrics ?? null,
  };
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
  };
}

export function confirmSepoliaSettlementBinding(input: {
  readonly intent: SettlementIntent;
  readonly ledger: Record<string, unknown>;
  readonly facilitatorReportedHash?: string | null;
}): { readonly binding: SettlementBindingRecord; readonly metrics: SettlementBindingMetrics } {
  const settlements = ledgerSettlementsToRows(input.ledger);
  const binding = confirmSettlementBinding({
    intent: input.intent,
    settlements,
    facilitatorReportedHash: input.facilitatorReportedHash,
  });
  const metrics = buildSettlementBindingMetrics({ ledger: input.ledger, binding });
  return { binding, metrics };
}

export function parseReconciliationLedger(json: Record<string, unknown>): {
  reconciliationStatus: string;
  safeToUseForPaymentVerification: boolean;
  unattributedSettlementsFound: number | null;
  balanceIdentityStatus: string;
  settlementTxHash: string | null;
  rpcUnavailable: boolean;
} {
  const reconciliationStatus = String(json.reconciliation_status ?? "unknown");
  const rpcUnavailable = reconciliationStatus.startsWith("RECONCILIATION_RPC");
  const settlements = Array.isArray(json.settlements) ? json.settlements : [];
  const proof = settlements.find(
    (row) =>
      typeof row === "object" &&
      row !== null &&
      (row as { matched_run?: string }).matched_run === "Sepolia_settlement_proof",
  ) as { tx_hash?: string } | undefined;
  return {
    reconciliationStatus,
    safeToUseForPaymentVerification: Boolean(json.safe_to_use_for_payment_verification),
    unattributedSettlementsFound:
      json.unattributed_settlements_found === null ||
      json.unattributed_settlements_found === undefined
        ? null
        : Number(json.unattributed_settlements_found),
    balanceIdentityStatus: String(json.balance_identity_status ?? "not_run"),
    settlementTxHash: proof?.tx_hash ?? null,
    rpcUnavailable,
  };
}

export function buildSepoliaReconcileArgs(selected: DiscoveredSelectedCandidate, balanceBeforeUsdc?: string): string[] {
  const args = [
    "--network",
    "sepolia",
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
  return args;
}
