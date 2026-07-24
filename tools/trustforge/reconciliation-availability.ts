/**
 * reconciliation-availability — structured ledgers for an unavailable reconciler.
 *
 * When on-chain reconciliation cannot run to completion the classifier must
 * still emit a structured, fail-closed RESULT with the *real* cause named — a
 * raw thrown stack trace is not a verdict. This module builds the ledger the
 * classify-runner materializes in place of a real one, and names the causes.
 *
 * Diagnosis (see docs/trustforge-reconciliation-availability.md):
 *   onchain_settlement_reconciliation.py queries Base JSON-RPC ONLY
 *   (eth_getLogs / eth_call / eth_getBlockByNumber / eth_getTransactionReceipt).
 *   It never calls the facilitator/CDP. The facilitator receipt is a local
 *   artifact read elsewhere, so `facilitator_receipt_parse_status: missing` does
 *   NOT mean a facilitator timeout — the "RPC" family of labels is accurate.
 */

import type { BoundedReconcileResult } from "./bounded-reconcile-spawn";

export const RECONCILIATION_LEDGER_SCHEMA_NAME = "trustforge_onchain_settlement_ledger";
export const RECONCILIATION_LEDGER_SCHEMA_VERSION = "0.2.0";

/** Bounded process deadline killed the RPC-only reconciler before it finished. */
export const RECONCILIATION_RPC_TIMEOUT = "RECONCILIATION_RPC_TIMEOUT";
/** The reconciler subprocess exited non-zero without producing a ledger. */
export const RECONCILIATION_SUBPROCESS_FAILED = "RECONCILIATION_SUBPROCESS_FAILED";

/** Statuses that mean reconciliation could not be trusted — always fail-closed. */
export function isReconciliationUnavailableStatus(status: string | null | undefined): boolean {
  if (!status) return false;
  return status.startsWith("RECONCILIATION_RPC") || status === RECONCILIATION_SUBPROCESS_FAILED;
}

export interface UnavailableReconciliationLedger {
  readonly schema_name: string;
  readonly schema_version: string;
  readonly reconciliation_status: string;
  readonly safe_to_use_for_payment_verification: false;
  readonly balance_identity_status: "not_run";
  readonly error_class: string;
  readonly reconciliation_detail: string;
  readonly settlements: readonly never[];
}

export function buildUnavailableReconciliationLedger(input: {
  readonly status: string;
  readonly detail: string;
}): UnavailableReconciliationLedger {
  return {
    schema_name: RECONCILIATION_LEDGER_SCHEMA_NAME,
    schema_version: RECONCILIATION_LEDGER_SCHEMA_VERSION,
    reconciliation_status: input.status,
    safe_to_use_for_payment_verification: false,
    balance_identity_status: "not_run",
    error_class: input.status,
    reconciliation_detail: input.detail,
    settlements: [],
  };
}

/** Ledger written when the TypeScript bounded spawn kills the reconciler on its deadline. */
export function buildReconciliationTimeoutLedger(
  maxTotalRuntimeSeconds?: number,
): UnavailableReconciliationLedger {
  const bound =
    maxTotalRuntimeSeconds && maxTotalRuntimeSeconds > 0 ? `${maxTotalRuntimeSeconds}s ` : "";
  return buildUnavailableReconciliationLedger({
    status: RECONCILIATION_RPC_TIMEOUT,
    detail: `bounded reconciliation subprocess exceeded its ${bound}deadline (RPC-only reconciler; not a facilitator/CDP call)`,
  });
}

/** Name the real cause of a non-timeout subprocess failure: exit code, signal, first stderr line. */
export function describeReconcileSubprocessFailure(result: BoundedReconcileResult): string {
  const firstStderrLine = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const parts = [
    `reconciler subprocess exited without a ledger`,
    `exit_code=${result.exitCode ?? "null"}`,
    `signal=${result.signal ?? "null"}`,
  ];
  if (firstStderrLine) parts.push(`stderr="${firstStderrLine.slice(0, 300)}"`);
  return parts.join(" ");
}

export function buildReconciliationSubprocessFailedLedger(
  result: BoundedReconcileResult,
): UnavailableReconciliationLedger {
  return buildUnavailableReconciliationLedger({
    status: RECONCILIATION_SUBPROCESS_FAILED,
    detail: describeReconcileSubprocessFailure(result),
  });
}

export type ReconcileMaterialization =
  | { readonly kind: "timeout"; readonly ledger: UnavailableReconciliationLedger }
  | { readonly kind: "subprocess_failed"; readonly ledger: UnavailableReconciliationLedger }
  | { readonly kind: "use_existing" };

/**
 * Decide which ledger (if any) the classify-runner must materialize after a
 * bounded reconcile. The one invariant: an unavailable reconciler ALWAYS maps to
 * a structured ledger, never a thrown error — so downstream always has a verdict.
 *   - timedOut            → structured RPC-timeout ledger
 *   - failed, no ledger   → structured subprocess-failed ledger (real cause named)
 *   - ok, or ledger present → use whatever the reconciler already wrote
 */
export function materializeReconcileLedger(input: {
  readonly result: BoundedReconcileResult;
  readonly ledgerExists: boolean;
  readonly maxTotalRuntimeSeconds?: number;
}): ReconcileMaterialization {
  if (input.result.timedOut) {
    return { kind: "timeout", ledger: buildReconciliationTimeoutLedger(input.maxTotalRuntimeSeconds) };
  }
  if (!input.result.ok && !input.ledgerExists) {
    return { kind: "subprocess_failed", ledger: buildReconciliationSubprocessFailedLedger(input.result) };
  }
  return { kind: "use_existing" };
}
