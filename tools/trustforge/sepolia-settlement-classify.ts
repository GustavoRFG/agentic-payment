/**
 * sepolia-settlement-classify — reconcile Sepolia ledger + three-outcome classifier.
 */

import { classifyPaidProbeOutcome, type PaidProbeOutcome } from "./paid-probe-outcome";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";

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
  };
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
