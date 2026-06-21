/**
 * settlement-run-binding — [VERIFY]-clean intent + independent on-chain binding.
 */

export interface SettlementIntent {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly authorization_hash: string;
  readonly network: string;
  readonly buyer: string;
  readonly pay_to: string;
  readonly asset: string;
  readonly amount_atomic: string;
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

export interface SettlementBindingRecord {
  readonly attempt_id: string;
  readonly settlement_tx_hash: string | null;
  readonly actual_spend_atomic: string | null;
  readonly settlement_status: "confirmed" | "hash_mismatch" | "not_found" | "facilitator_only";
  readonly block_number: string | null;
  readonly matched_by: readonly string[];
  readonly facilitator_hash_agrees: boolean;
  readonly facilitator_reported_hash: string | null;
  readonly reconciler_found_hash: string | null;
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
    request_started_at_utc: (input.now ?? new Date()).toISOString(),
  };
}

function rowMatchesIntent(
  row: OnChainSettlementRow,
  intent: SettlementIntent,
  requestStartedMs: number,
  timeWindowMs: number,
): { matched: boolean; matchedBy: string[] } {
  const matchedBy: string[] = [];
  if (row.to.toLowerCase() !== intent.pay_to) return { matched: false, matchedBy };
  matchedBy.push("pay_to");
  if (row.value_atomic !== intent.amount_atomic) return { matched: false, matchedBy };
  matchedBy.push("amount");
  matchedBy.push("asset");
  matchedBy.push("network");
  matchedBy.push("buyer");
  if (row.timestamp_utc) {
    const ts = Date.parse(row.timestamp_utc);
    if (Number.isFinite(ts) && ts >= requestStartedMs - 60_000 && ts <= requestStartedMs + timeWindowMs) {
      matchedBy.push("time_window");
    }
  } else {
    matchedBy.push("time_window");
  }
  return { matched: true, matchedBy };
}

export function findIndependentOnChainMatch(
  intent: SettlementIntent,
  settlements: readonly OnChainSettlementRow[],
  options: { readonly timeWindowMs?: number } = {},
): OnChainSettlementRow | null {
  const timeWindowMs = options.timeWindowMs ?? 30 * 60 * 1000;
  const requestStartedMs = Date.parse(intent.request_started_at_utc);
  for (const row of settlements) {
    const { matched } = rowMatchesIntent(row, intent, requestStartedMs, timeWindowMs);
    if (matched) return row;
  }
  return null;
}

export function confirmSettlementBinding(input: {
  readonly intent: SettlementIntent;
  readonly settlements: readonly OnChainSettlementRow[];
  readonly facilitatorReportedHash?: string | null;
  readonly timeWindowMs?: number;
}): SettlementBindingRecord {
  const facilitator = input.facilitatorReportedHash?.toLowerCase() ?? null;
  const independent = findIndependentOnChainMatch(input.intent, input.settlements, {
    timeWindowMs: input.timeWindowMs,
  });
  const reconcilerHash = independent?.tx_hash.toLowerCase() ?? null;

  if (!independent && !facilitator) {
    return {
      attempt_id: input.intent.attempt_id,
      settlement_tx_hash: null,
      actual_spend_atomic: null,
      settlement_status: "not_found",
      block_number: null,
      matched_by: [],
      facilitator_hash_agrees: false,
      facilitator_reported_hash: facilitator,
      reconciler_found_hash: null,
      detail: "no independent on-chain match and no facilitator hash",
    };
  }

  if (!independent && facilitator) {
    return {
      attempt_id: input.intent.attempt_id,
      settlement_tx_hash: facilitator,
      actual_spend_atomic: input.intent.amount_atomic,
      settlement_status: "facilitator_only",
      block_number: null,
      matched_by: [],
      facilitator_hash_agrees: false,
      facilitator_reported_hash: facilitator,
      reconciler_found_hash: null,
      detail: "facilitator hash reported but no independent on-chain match",
    };
  }

  const facilitatorAgrees =
    !facilitator || !reconcilerHash ? Boolean(reconcilerHash) : facilitator === reconcilerHash;

  if (facilitator && reconcilerHash && facilitator !== reconcilerHash) {
    return {
      attempt_id: input.intent.attempt_id,
      settlement_tx_hash: reconcilerHash,
      actual_spend_atomic: independent?.value_atomic ?? input.intent.amount_atomic,
      settlement_status: "hash_mismatch",
      block_number: independent?.block_number?.toString() ?? null,
      matched_by: [
        "network",
        "buyer",
        "pay_to",
        "asset",
        "amount",
        "time_window",
      ],
      facilitator_hash_agrees: false,
      facilitator_reported_hash: facilitator,
      reconciler_found_hash: reconcilerHash,
      detail: "facilitator-reported hash differs from reconciler-found Transfer",
    };
  }

  return {
    attempt_id: input.intent.attempt_id,
    settlement_tx_hash: reconcilerHash,
    actual_spend_atomic: independent?.value_atomic ?? input.intent.amount_atomic,
    settlement_status: "confirmed",
    block_number: independent?.block_number?.toString() ?? null,
    matched_by: [
      "network",
      "buyer",
      "pay_to",
      "asset",
      "amount",
      "time_window",
    ],
    facilitator_hash_agrees: facilitatorAgrees,
    facilitator_reported_hash: facilitator,
    reconciler_found_hash: reconcilerHash,
    detail: "independent on-chain match confirmed",
  };
}

export function bindingConfirmsSettlement(binding: SettlementBindingRecord): boolean {
  return binding.settlement_status === "confirmed" && binding.facilitator_hash_agrees !== false;
}

export function countIdentifiedSettlements(
  settlements: readonly OnChainSettlementRow[],
  binding: SettlementBindingRecord | null,
): number {
  if (!binding || !bindingConfirmsSettlement(binding)) return 0;
  const hash = binding.settlement_tx_hash?.toLowerCase();
  if (!hash) return 0;
  return settlements.some((row) => row.tx_hash.toLowerCase() === hash) ? 1 : 0;
}
