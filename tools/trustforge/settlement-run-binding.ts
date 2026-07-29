/**
 * settlement-run-binding — [VERIFY]-clean intent + independent on-chain binding.
 */

import type { SanitizedFacilitatorReceipt } from "./facilitator-settlement-receipt";

export const CLOCK_SKEW_TOLERANCE_MS = 120_000 as const;
export const ONCHAIN_SETTLEMENT_GRACE_MS = 30 * 60 * 1000 as const;

export function resolveBindingUpperBoundUtc(input: {
  readonly executionEndUtc?: string | null;
  readonly classificationStartedUtc?: string;
}): string {
  const classificationMs = Date.parse(input.classificationStartedUtc ?? new Date().toISOString());
  const executionEndMs = input.executionEndUtc ? Date.parse(input.executionEndUtc) : Number.NaN;
  const upperMs = Number.isFinite(executionEndMs)
    ? Math.max(executionEndMs + ONCHAIN_SETTLEMENT_GRACE_MS, classificationMs)
    : classificationMs;
  return new Date(upperMs).toISOString();
}

export interface SettlementIntent {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly authorization_hash: string;
  readonly network: string;
  readonly buyer: string;
  readonly pay_to: string;
  readonly asset: string;
  readonly amount_atomic: string;
  /** HTTP method bound to this attempt; must equal the authorized method. */
  readonly method?: string;
  readonly request_started_at_utc: string;
}

export interface OnChainSettlementRow {
  readonly tx_hash: string;
  readonly to: string;
  readonly value_atomic: string;
  readonly value_usdc?: string;
  readonly block_number?: number;
  readonly timestamp_utc?: string | null;
  readonly matched_run?: string | null;
}

export interface NormalizedSettlementCandidate {
  readonly txHash: string;
  readonly blockNumber: number | null;
  readonly timestampUtc: string | null;
  readonly network: string;
  readonly buyer: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amountAtomic: string;
}

export type SettlementBindingStatus =
  | "confirmed"
  | "settlement_not_found"
  | "ambiguous_match"
  | "facilitator_receipt_missing"
  | "facilitator_receipt_malformed"
  | "facilitator_hash_missing"
  | "hash_mismatch"
  | "facilitator_only";

export type FacilitatorHashCrossCheck = "agree" | "missing" | "mismatch";

export interface SettlementBindingRecord {
  readonly attempt_id: string;
  readonly run_id: string | null;
  readonly authorization_hash: string | null;
  readonly settlement_tx_hash: string | null;
  readonly actual_spend_atomic: string | null;
  readonly settlement_status: SettlementBindingStatus;
  readonly block_number: string | null;
  readonly matched_by: readonly string[];
  readonly facilitator_hash_agrees: boolean | null;
  readonly facilitator_hash_cross_check: FacilitatorHashCrossCheck;
  readonly facilitator_reported_hash: string | null;
  readonly reconciler_found_hash: string | null;
  readonly facilitator_receipt: {
    readonly source: SanitizedFacilitatorReceipt["source"];
    readonly parse_status: SanitizedFacilitatorReceipt["parseStatus"];
    readonly transaction_hash: string | null;
  } | null;
  readonly independent_match: {
    readonly settlement_tx_hash: string;
    readonly block_number: number | null;
    readonly timestamp_utc: string | null;
    readonly actual_spend_atomic: string;
  } | null;
  readonly current_attempt_candidates_after_filter: number;
  readonly rejected_candidates: readonly {
    readonly tx_hash: string;
    readonly rejected_reason: string;
  }[];
  readonly detail: string;
}

export function buildSettlementIntent(input: {
  readonly attemptId: string;
  readonly runId: string;
  readonly authorizationHash: string;
  readonly network: string;
  readonly buyer: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly method?: string;
  readonly now?: Date;
}): SettlementIntent {
  return {
    attempt_id: input.attemptId,
    run_id: input.runId,
    authorization_hash: input.authorizationHash,
    network: input.network,
    buyer: input.buyer.toLowerCase(),
    pay_to: input.payTo.toLowerCase(),
    asset: input.asset.toLowerCase(),
    amount_atomic: input.amountAtomic,
    ...(input.method ? { method: input.method } : {}),
    request_started_at_utc: (input.now ?? new Date()).toISOString(),
  };
}

export function normalizeSettlementTxHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

export function normalizeOptionalFacilitatorHash(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return normalizeSettlementTxHash(value);
}

export function normalizeSettlementRow(
  row: Record<string, unknown>,
  intent: SettlementIntent,
): NormalizedSettlementCandidate | null {
  const txHash = normalizeSettlementTxHash(
    row.tx_hash ?? row.txHash ?? row.transaction_hash ?? row.transactionHash,
  );
  if (!txHash) return null;
  const blockRaw = row.block_number ?? row.blockNumber;
  const blockNumber =
    typeof blockRaw === "number"
      ? blockRaw
      : Number.parseInt(String(blockRaw ?? ""), 10);
  const timestampRaw = row.timestamp_utc ?? row.timestampUtc ?? row.timestamp;
  return {
    txHash,
    blockNumber: Number.isFinite(blockNumber) ? blockNumber : null,
    timestampUtc:
      timestampRaw === null || timestampRaw === undefined ? null : String(timestampRaw),
    network: intent.network,
    buyer: intent.buyer,
    payTo: String(row.to ?? row.pay_to ?? row.payTo ?? "").toLowerCase(),
    asset: intent.asset,
    amountAtomic: String(row.value_atomic ?? row.amount_atomic ?? row.amount ?? ""),
  };
}

export function evaluateTimeWindow(input: {
  readonly timestampUtc: string | null;
  readonly requestStartedMs: number;
  readonly upperBoundMs: number;
  readonly clockSkewToleranceMs?: number;
}): { readonly inWindow: boolean; readonly rejectedReason: string | null } {
  const tolerance = input.clockSkewToleranceMs ?? CLOCK_SKEW_TOLERANCE_MS;
  if (!input.timestampUtc) {
    return { inWindow: false, rejectedReason: "missing_timestamp" };
  }
  const candidateMs = Date.parse(input.timestampUtc);
  if (!Number.isFinite(candidateMs)) {
    return { inWindow: false, rejectedReason: "invalid_timestamp" };
  }
  const lowerBoundMs = input.requestStartedMs - tolerance;
  if (candidateMs < lowerBoundMs) {
    return { inWindow: false, rejectedReason: "before_intent_window" };
  }
  if (candidateMs > input.upperBoundMs) {
    return { inWindow: false, rejectedReason: "after_intent_window" };
  }
  return { inWindow: true, rejectedReason: null };
}

export function evaluateCandidateDimensions(
  candidate: NormalizedSettlementCandidate,
  intent: SettlementIntent,
): { readonly matchedBy: string[]; readonly allMatch: boolean; readonly failReason: string | null } {
  const matchedBy: string[] = [];
  matchedBy.push("network");
  matchedBy.push("buyer");
  if (candidate.payTo !== intent.pay_to) {
    return { matchedBy, allMatch: false, failReason: "pay_to_mismatch" };
  }
  matchedBy.push("pay_to");
  if (candidate.amountAtomic !== intent.amount_atomic) {
    return { matchedBy, allMatch: false, failReason: "amount_mismatch" };
  }
  matchedBy.push("amount");
  matchedBy.push("asset");
  return { matchedBy, allMatch: true, failReason: null };
}

export interface EligibleSettlementCandidate {
  readonly candidate: NormalizedSettlementCandidate;
  readonly row: OnChainSettlementRow;
  readonly matchedBy: readonly string[];
}

export function findEligibleSettlementCandidates(input: {
  readonly intent: SettlementIntent;
  readonly settlements: readonly OnChainSettlementRow[];
  readonly upperBoundUtc: string;
  readonly clockSkewToleranceMs?: number;
}): {
  readonly eligible: readonly EligibleSettlementCandidate[];
  readonly rejected: readonly { readonly tx_hash: string; readonly rejected_reason: string }[];
} {
  const requestStartedMs = Date.parse(input.intent.request_started_at_utc);
  const upperBoundMs = Date.parse(input.upperBoundUtc);
  if (!Number.isFinite(requestStartedMs) || !Number.isFinite(upperBoundMs)) {
    throw new Error("BLOCKED_BINDING_TIME_BOUNDS: invalid intent or upper bound timestamp");
  }

  const eligible: EligibleSettlementCandidate[] = [];
  const rejected: { tx_hash: string; rejected_reason: string }[] = [];

  for (const row of input.settlements) {
    const rowRecord = row as unknown as Record<string, unknown>;
    const txHash = normalizeSettlementTxHash(
      rowRecord.tx_hash ?? rowRecord.txHash ?? rowRecord.transaction_hash ?? rowRecord.transactionHash,
    );
    if (!txHash) {
      rejected.push({ tx_hash: String(row.tx_hash ?? ""), rejected_reason: "invalid_tx_hash" });
      continue;
    }
    const candidate = normalizeSettlementRow(row as unknown as Record<string, unknown>, input.intent);
    if (!candidate) {
      rejected.push({ tx_hash: txHash, rejected_reason: "invalid_tx_hash" });
      continue;
    }
    const dims = evaluateCandidateDimensions(candidate, input.intent);
    if (!dims.allMatch) {
      rejected.push({ tx_hash: txHash, rejected_reason: dims.failReason ?? "dimension_mismatch" });
      continue;
    }
    const time = evaluateTimeWindow({
      timestampUtc: candidate.timestampUtc,
      requestStartedMs,
      upperBoundMs,
      clockSkewToleranceMs: input.clockSkewToleranceMs,
    });
    if (!time.inWindow) {
      rejected.push({
        tx_hash: txHash,
        rejected_reason: time.rejectedReason ?? "time_window",
      });
      continue;
    }
    eligible.push({
      candidate,
      row,
      matchedBy: [...dims.matchedBy, "time_window"],
    });
  }

  return { eligible, rejected };
}

/** @deprecated use findEligibleSettlementCandidates */
export function findIndependentOnChainMatch(
  intent: SettlementIntent,
  settlements: readonly OnChainSettlementRow[],
  options: {
    readonly timeWindowMs?: number;
    readonly upperBoundUtc?: string;
    readonly clockSkewToleranceMs?: number;
  } = {},
): OnChainSettlementRow | null {
  const upperBoundUtc =
    options.upperBoundUtc ?? new Date(Date.now() + (options.timeWindowMs ?? 30 * 60 * 1000)).toISOString();
  const { eligible } = findEligibleSettlementCandidates({
    intent,
    settlements,
    upperBoundUtc,
    clockSkewToleranceMs: options.clockSkewToleranceMs,
  });
  return eligible.length === 1 ? eligible[0].row : null;
}

function buildIndependentMatch(
  eligible: EligibleSettlementCandidate,
): NonNullable<SettlementBindingRecord["independent_match"]> {
  return {
    settlement_tx_hash: eligible.candidate.txHash,
    block_number: eligible.candidate.blockNumber,
    timestamp_utc: eligible.candidate.timestampUtc,
    actual_spend_atomic: eligible.candidate.amountAtomic,
  };
}

function resolveFacilitatorHash(input: {
  readonly facilitatorReceipt?: SanitizedFacilitatorReceipt | null;
  readonly facilitatorReportedHash?: string | null;
}): {
  readonly hash: string | null;
  readonly receipt: SanitizedFacilitatorReceipt | null;
  readonly receiptMissing: boolean;
  readonly receiptMalformed: boolean;
} {
  if (input.facilitatorReceipt) {
    const receipt = input.facilitatorReceipt;
    if (receipt.parseStatus === "missing") {
      return { hash: null, receipt, receiptMissing: true, receiptMalformed: false };
    }
    if (receipt.parseStatus === "malformed" || receipt.parseStatus === "unsupported") {
      return { hash: null, receipt, receiptMissing: false, receiptMalformed: true };
    }
    return {
      hash: receipt.transactionHash,
      receipt,
      receiptMissing: false,
      receiptMalformed: false,
    };
  }
  const legacy = normalizeOptionalFacilitatorHash(input.facilitatorReportedHash);
  if (!legacy && (input.facilitatorReportedHash === null || input.facilitatorReportedHash === undefined)) {
    return { hash: null, receipt: null, receiptMissing: true, receiptMalformed: false };
  }
  if (!legacy) {
    return { hash: null, receipt: null, receiptMissing: false, receiptMalformed: true };
  }
  return {
    hash: legacy,
    receipt: {
      parseStatus: "parsed",
      source: "none",
      rawHeaderName: null,
      transactionHash: legacy as `0x${string}`,
      network: null,
      payer: null,
      payTo: null,
      asset: null,
      amountAtomic: null,
      facilitator: null,
      settledAtUtc: null,
      parseErrorClass: null,
    },
    receiptMissing: false,
    receiptMalformed: false,
  };
}

function receiptSummary(
  receipt: SanitizedFacilitatorReceipt | null,
): SettlementBindingRecord["facilitator_receipt"] {
  if (!receipt) return null;
  return {
    source: receipt.source,
    parse_status: receipt.parseStatus,
    transaction_hash: receipt.transactionHash,
  };
}

export function confirmSettlementBinding(input: {
  readonly intent: SettlementIntent;
  readonly settlements: readonly OnChainSettlementRow[];
  readonly facilitatorReceipt?: SanitizedFacilitatorReceipt | null;
  readonly facilitatorReportedHash?: string | null;
  readonly upperBoundUtc: string;
  readonly clockSkewToleranceMs?: number;
}): SettlementBindingRecord {
  const facilitatorState = resolveFacilitatorHash({
    facilitatorReceipt: input.facilitatorReceipt,
    facilitatorReportedHash: input.facilitatorReportedHash,
  });
  const facilitator = facilitatorState.hash;
  const { eligible, rejected } = findEligibleSettlementCandidates({
    intent: input.intent,
    settlements: input.settlements,
    upperBoundUtc: input.upperBoundUtc,
    clockSkewToleranceMs: input.clockSkewToleranceMs,
  });

  const base = {
    attempt_id: input.intent.attempt_id,
    run_id: input.intent.run_id,
    authorization_hash: input.intent.authorization_hash,
    current_attempt_candidates_after_filter: eligible.length,
    rejected_candidates: rejected,
    facilitator_receipt: receiptSummary(facilitatorState.receipt),
  };

  if (eligible.length === 0) {
    return {
      ...base,
      settlement_tx_hash: null,
      actual_spend_atomic: null,
      settlement_status: "settlement_not_found",
      block_number: null,
      matched_by: [],
      facilitator_hash_agrees: null,
      facilitator_hash_cross_check: facilitator ? "mismatch" : "missing",
      facilitator_reported_hash: facilitator,
      reconciler_found_hash: null,
      independent_match: null,
      detail:
        facilitator && !rejected.length
          ? "facilitator hash reported but no independent on-chain match"
          : "no independent on-chain match in intent time window",
    };
  }

  if (eligible.length > 1) {
    return {
      ...base,
      settlement_tx_hash: null,
      actual_spend_atomic: null,
      settlement_status: "ambiguous_match",
      block_number: null,
      matched_by: [],
      facilitator_hash_agrees: null,
      facilitator_hash_cross_check: facilitator ? "mismatch" : "missing",
      facilitator_reported_hash: facilitator,
      reconciler_found_hash: null,
      independent_match: null,
      detail: `${eligible.length} independent on-chain matches in intent time window`,
    };
  }

  const match = eligible[0];
  const reconcilerHash = match.candidate.txHash;
  const independentMatch = buildIndependentMatch(match);

  if (facilitatorState.receiptMissing) {
    return {
      ...base,
      settlement_tx_hash: reconcilerHash,
      actual_spend_atomic: match.candidate.amountAtomic,
      settlement_status: "facilitator_receipt_missing",
      block_number: match.candidate.blockNumber?.toString() ?? null,
      matched_by: match.matchedBy,
      facilitator_hash_agrees: null,
      facilitator_hash_cross_check: "missing",
      facilitator_reported_hash: null,
      reconciler_found_hash: reconcilerHash,
      independent_match: independentMatch,
      detail: "independent on-chain match found; facilitator receipt missing",
    };
  }

  if (facilitatorState.receiptMalformed) {
    return {
      ...base,
      settlement_tx_hash: reconcilerHash,
      actual_spend_atomic: match.candidate.amountAtomic,
      settlement_status: "facilitator_receipt_malformed",
      block_number: match.candidate.blockNumber?.toString() ?? null,
      matched_by: match.matchedBy,
      facilitator_hash_agrees: null,
      facilitator_hash_cross_check: "missing",
      facilitator_reported_hash: null,
      reconciler_found_hash: reconcilerHash,
      independent_match: independentMatch,
      detail: "independent on-chain match found; facilitator receipt malformed",
    };
  }

  if (!facilitator) {
    return {
      ...base,
      settlement_tx_hash: reconcilerHash,
      actual_spend_atomic: match.candidate.amountAtomic,
      settlement_status: "facilitator_hash_missing",
      block_number: match.candidate.blockNumber?.toString() ?? null,
      matched_by: match.matchedBy,
      facilitator_hash_agrees: null,
      facilitator_hash_cross_check: "missing",
      facilitator_reported_hash: null,
      reconciler_found_hash: reconcilerHash,
      independent_match: independentMatch,
      detail: "independent on-chain match found; facilitator hash missing",
    };
  }

  if (facilitator !== reconcilerHash) {
    return {
      ...base,
      settlement_tx_hash: reconcilerHash,
      actual_spend_atomic: match.candidate.amountAtomic,
      settlement_status: "hash_mismatch",
      block_number: match.candidate.blockNumber?.toString() ?? null,
      matched_by: match.matchedBy,
      facilitator_hash_agrees: false,
      facilitator_hash_cross_check: "mismatch",
      facilitator_reported_hash: facilitator,
      reconciler_found_hash: reconcilerHash,
      independent_match: independentMatch,
      detail: "facilitator-reported hash differs from reconciler-found Transfer",
    };
  }

  return {
    ...base,
    settlement_tx_hash: reconcilerHash,
    actual_spend_atomic: match.candidate.amountAtomic,
    settlement_status: "confirmed",
    block_number: match.candidate.blockNumber?.toString() ?? null,
    matched_by: match.matchedBy,
    facilitator_hash_agrees: true,
    facilitator_hash_cross_check: "agree",
    facilitator_reported_hash: facilitator,
    reconciler_found_hash: reconcilerHash,
    independent_match: independentMatch,
    detail: "independent on-chain match confirmed with facilitator hash agreement",
  };
}

export function bindingConfirmsSettlement(binding: SettlementBindingRecord): boolean {
  return binding.settlement_status === "confirmed" && binding.facilitator_hash_cross_check === "agree";
}

export function countIdentifiedSettlements(
  settlements: readonly OnChainSettlementRow[],
  binding: SettlementBindingRecord | null,
): number {
  if (!binding || !bindingConfirmsSettlement(binding)) return 0;
  const hash = binding.settlement_tx_hash?.toLowerCase();
  if (!hash) return 0;
  return settlements.some((row) => {
    const rowRecord = row as unknown as Record<string, unknown>;
    return (
      normalizeSettlementTxHash(
        rowRecord.tx_hash ?? rowRecord.txHash ?? rowRecord.transaction_hash ?? rowRecord.transactionHash,
      ) === hash
    );
  })
    ? 1
    : 0;
}
