/**
 * map-rich-payment-attempts — map saved rich runs to reconciled USDC settlements.
 */

import type { UsdcSettlementReconciliation, UsdcTransferEvent } from "./reconcile-usdc-settlements";

export type MappingConfidence = "high" | "medium" | "low" | "unknown";

export interface SavedRichRunSummary {
  readonly run_dir: string;
  readonly run_id: string;
  readonly observed_at_utc: string | null;
  readonly payment_bearing_http_request_count: number;
  readonly seller_response_captured: boolean;
  readonly seller_response_body_sha256: string | null;
  readonly saved_transaction_hash: string | null;
  readonly quote_usdc: string | null;
}

export interface PaymentAttemptMapping {
  readonly run_dir: string;
  readonly payment_bearing_http_request_count: number;
  readonly seller_response_captured: boolean;
  readonly seller_response_body_sha256: string | null;
  readonly saved_transaction_hash: string | null;
  readonly mapped_settlement_tx_hash: string | null;
  readonly mapped_settlement_confidence: MappingConfidence;
  readonly amount_usdc: string | null;
}

export interface PaymentAttemptMappingReport {
  readonly attempts: readonly PaymentAttemptMapping[];
  readonly unmapped_settlements: readonly UsdcTransferEvent[];
  readonly unmapped_attempts: readonly string[];
  readonly attempt_mapping_status: "PASS" | "PARTIAL" | "AMBIGUOUS" | "FAIL";
}

function parseRunTimestampUtc(runId: string): string | null {
  const match = /^run_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(runId);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
}

export function summarizeSavedRichRun(runDir: string, probe: {
  readonly payment?: {
    readonly payment_bearing_http_request_count?: number;
    readonly transaction_hash?: string | null;
  };
  readonly seller_response?: { readonly body_sha256?: string | null };
  readonly created_at_utc?: string;
}, handshakeQuoteUsdc?: string | null): SavedRichRunSummary {
  const runId = runDir.split(/[\\/]/).pop() ?? runDir;
  return {
    run_dir: runDir,
    run_id: runId,
    observed_at_utc: probe.created_at_utc ?? parseRunTimestampUtc(runId),
    payment_bearing_http_request_count: probe.payment?.payment_bearing_http_request_count ?? 0,
    seller_response_captured: Boolean(probe.seller_response?.body_sha256),
    seller_response_body_sha256: probe.seller_response?.body_sha256 ?? null,
    saved_transaction_hash: probe.payment?.transaction_hash ?? null,
    quote_usdc: handshakeQuoteUsdc ?? "0.001125",
  };
}

export function mapRichPaymentAttempts(input: {
  readonly runs: readonly SavedRichRunSummary[];
  readonly reconciliation: UsdcSettlementReconciliation;
}): PaymentAttemptMappingReport {
  const zapperEvents = input.reconciliation.events.filter(
    (event) => event.candidate_match === "zapper_rich_tx_explainer",
  );
  const sortedRuns = [...input.runs].sort((a, b) =>
    (a.observed_at_utc ?? a.run_id).localeCompare(b.observed_at_utc ?? b.run_id),
  );

  const attempts: PaymentAttemptMapping[] = [];
  const usedEvents = new Set<string>();

  for (let index = 0; index < sortedRuns.length; index += 1) {
    const run = sortedRuns[index];
    const event = zapperEvents[index] ?? null;
    let confidence: MappingConfidence = "unknown";
    let mappedHash: string | null = null;
    let amount: string | null = null;

    if (event) {
      mappedHash = event.tx_hash;
      amount = event.amount_decimal;
      usedEvents.add(`${event.tx_hash}:${event.log_index}`);
      if (zapperEvents.length === sortedRuns.length) {
        confidence = "high";
      } else if (zapperEvents.length === 2 && sortedRuns.length === 3 && index < 2) {
        confidence = "medium";
      } else if (index < zapperEvents.length) {
        confidence = "medium";
      } else {
        confidence = "low";
      }
    }

    attempts.push({
      run_dir: run.run_dir,
      payment_bearing_http_request_count: run.payment_bearing_http_request_count,
      seller_response_captured: run.seller_response_captured,
      seller_response_body_sha256: run.seller_response_body_sha256,
      saved_transaction_hash: run.saved_transaction_hash,
      mapped_settlement_tx_hash: mappedHash,
      mapped_settlement_confidence: event ? confidence : "unknown",
      amount_usdc: amount,
    });
  }

  const unmappedSettlements = zapperEvents.filter(
    (event) => !usedEvents.has(`${event.tx_hash}:${event.log_index}`),
  );
  const unmappedAttempts = attempts
    .filter((attempt) => !attempt.mapped_settlement_tx_hash)
    .map((attempt) => attempt.run_dir);

  let attemptMappingStatus: PaymentAttemptMappingReport["attempt_mapping_status"] = "FAIL";
  if (
    zapperEvents.length > 0 &&
    unmappedSettlements.length === 0 &&
    unmappedAttempts.length === 0 &&
    attempts.every((attempt) => attempt.mapped_settlement_confidence === "high")
  ) {
    attemptMappingStatus = "PASS";
  } else if (zapperEvents.length > 0 && unmappedAttempts.length === 0 && unmappedSettlements.length === 0) {
    attemptMappingStatus = "PARTIAL";
  } else if (zapperEvents.length > 0) {
    attemptMappingStatus = "AMBIGUOUS";
  }

  return {
    attempts,
    unmapped_settlements: unmappedSettlements,
    unmapped_attempts: unmappedAttempts,
    attempt_mapping_status: attemptMappingStatus,
  };
}
