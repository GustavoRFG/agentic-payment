/**
 * payment-attempt-ledger — per-attempt accounting ledger for rich probes.
 */

import type { SettlementEvidence } from "./settlement-evidence";

export type PaymentIntegrityOutcome = "pass" | "fail" | "ambiguous" | "not_executed";
export type ActualSpendSource = "saved_header" | "chain_reconciliation" | null;

export interface PaymentAttemptLedgerEntry {
  readonly attemptId: string;
  readonly runId: string;
  readonly serviceId: string;
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly targetTaskId: string;
  readonly targetTxHash?: string;
  readonly quoteUsdc: string | null;
  readonly capUsdc: string | null;
  readonly paymentBearingHttpRequestCount: number;
  readonly walletFingerprint: string | null;
  readonly sellerResponseCaptured: boolean;
  readonly sellerResponseBodySha256: string | null;
  readonly savedSettlementEvidence: SettlementEvidence;
  readonly chainReconciledSettlementEvidence: SettlementEvidence | null;
  readonly actualSpendUsdc: string | null;
  readonly actualSpendSource: ActualSpendSource;
  readonly finalPaymentIntegrity: PaymentIntegrityOutcome;
  readonly createdAtUtc: string;
}

export interface PaymentAttemptLedger {
  readonly schema_version: "trustforge_payment_attempt_ledger_v0.1.0";
  readonly service_id: string;
  readonly entries: readonly PaymentAttemptLedgerEntry[];
  readonly actual_total_spend_usdc: string | null;
  readonly reconciled_settlement_count: number;
}

function sumUsdc(values: readonly string[]): string | null {
  if (values.length === 0) return null;
  const micro = values.reduce((sum, value) => {
    const [whole, frac = ""] = value.split(".");
    return sum + BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  }, 0n);
  const whole = micro / 1_000_000n;
  const frac = micro % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

export function buildPaymentAttemptLedger(
  entries: readonly PaymentAttemptLedgerEntry[],
  serviceId: string,
): PaymentAttemptLedger {
  const spends = entries
    .map((entry) => entry.actualSpendUsdc)
    .filter((value): value is string => Boolean(value));
  return {
    schema_version: "trustforge_payment_attempt_ledger_v0.1.0",
    service_id: serviceId,
    entries,
    actual_total_spend_usdc: sumUsdc(spends),
    reconciled_settlement_count: entries.filter(
      (entry) => entry.chainReconciledSettlementEvidence?.transactionHash,
    ).length,
  };
}

export function runIdFromDir(runDir: string): string {
  return runDir.split(/[\\/]/).pop() ?? runDir;
}
