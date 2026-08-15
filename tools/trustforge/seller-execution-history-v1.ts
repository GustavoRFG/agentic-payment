/**
 * seller-execution-history-v1 — observational seller evidence (B.6.3).
 * Does NOT grant autonomy. Thresholds live in AutonomyAuthority.
 */

import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const SELLER_EXECUTION_HISTORY_SCHEMA =
  "trustforge_seller_execution_history.v1" as const;

export interface SellerExecutionHistoryV1 {
  readonly schemaVersion: typeof SELLER_EXECUTION_HISTORY_SCHEMA;
  readonly seller: string;
  readonly provider: string;
  readonly successfulSettlements: number;
  readonly distinctSuccessfulDays: number;
  readonly failedPaytimeAttempts: number;
  readonly ambiguousSendEvents: number;
  readonly requirementInstabilityEvents: number;
  readonly sellerIdentityChangeEvents: number;
  readonly unresolvedIdentityChanges: number;
  readonly deliveredUtilityObservations: number;
  readonly lastSuccessfulAt: string | null;
  readonly historyAsOf: string;
  readonly historyHash: string;
}

export function sellerExecutionHistoryHash(
  h: Omit<SellerExecutionHistoryV1, "historyHash">,
): string {
  return canonicalJsonSha256({
    schemaVersion: h.schemaVersion,
    seller: h.seller.toLowerCase(),
    provider: h.provider,
    successfulSettlements: h.successfulSettlements,
    distinctSuccessfulDays: h.distinctSuccessfulDays,
    failedPaytimeAttempts: h.failedPaytimeAttempts,
    ambiguousSendEvents: h.ambiguousSendEvents,
    requirementInstabilityEvents: h.requirementInstabilityEvents,
    sellerIdentityChangeEvents: h.sellerIdentityChangeEvents,
    unresolvedIdentityChanges: h.unresolvedIdentityChanges,
    deliveredUtilityObservations: h.deliveredUtilityObservations,
    lastSuccessfulAt: h.lastSuccessfulAt,
    historyAsOf: h.historyAsOf,
  });
}

export function buildSellerExecutionHistory(
  input: Omit<SellerExecutionHistoryV1, "historyHash" | "schemaVersion">,
): SellerExecutionHistoryV1 {
  const partial = {
    schemaVersion: SELLER_EXECUTION_HISTORY_SCHEMA,
    ...input,
    seller: input.seller.toLowerCase(),
  };
  return { ...partial, historyHash: sellerExecutionHistoryHash(partial) };
}
