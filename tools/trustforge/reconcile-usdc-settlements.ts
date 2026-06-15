/**
 * reconcile-usdc-settlements — read-only Base USDC Transfer log reconciliation.
 */

import {
  DEFAULT_BASE_RPC_SOURCES,
  ERC20_TRANSFER_TOPIC,
  USDC_BASE_ADDRESS,
} from "./build-tx-ground-truth";

export type SettlementReconciliationStatus =
  | "SETTLEMENT_FOUND_BY_CHAIN_RECONCILIATION"
  | "NO_SETTLEMENT_FOUND_ONCHAIN"
  | "SETTLEMENT_FOUND_THREE_ATTEMPTS"
  | "AMBIGUOUS_REQUIRES_MANUAL_REVIEW";

export interface UsdcTransferEvent {
  readonly tx_hash: string;
  readonly block_number: number;
  readonly block_timestamp_utc: string | null;
  readonly from: string;
  readonly to: string;
  readonly amount_atomic: string;
  readonly amount_decimal: string;
  readonly log_index: number;
  readonly transaction_index: number;
  readonly candidate_match: "zapper_rich_tx_explainer" | "phase2_or_onesource" | "other";
}

export interface UsdcSettlementReconciliation {
  readonly wallet: string;
  readonly token: string;
  readonly from_block: number;
  readonly to_block: number | "latest";
  readonly events: readonly UsdcTransferEvent[];
  readonly zapper_candidate_count: number;
  readonly zapper_candidate_total_usdc: string;
  readonly settlement_reconciliation_status: SettlementReconciliationStatus;
  readonly reconciled_payment_count: number;
  readonly reconciled_total_usdc: string;
}

const ZAPPER_QUOTE_ATOMIC = 1125n;
const PHASE2_QUOTE_ATOMIC = 1000n;

function padTopicAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

function topicAddress(topic: string | undefined): string {
  if (!topic || !topic.startsWith("0x")) return "";
  const hex = topic.slice(2).padStart(64, "0");
  return `0x${hex.slice(24)}`.toLowerCase();
}

function atomicToDecimal(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

function sumDecimal(values: readonly string[]): string {
  const totalMicro = values.reduce((sum, value) => {
    const [whole, frac = ""] = value.split(".");
    const micro =
      BigInt(whole) * 1_000_000n +
      BigInt((frac + "000000").slice(0, 6));
    return sum + micro;
  }, 0n);
  return atomicToDecimal(totalMicro);
}

async function rpc(
  fetchImpl: typeof fetch,
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "manual",
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

async function rpcFirst(
  fetchImpl: typeof fetch,
  method: string,
  params: unknown[],
): Promise<unknown> {
  let lastError: unknown = null;
  for (const url of DEFAULT_BASE_RPC_SOURCES) {
    try {
      return await rpc(fetchImpl, url, method, params);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function classifyCandidate(amountAtomic: bigint): UsdcTransferEvent["candidate_match"] {
  if (amountAtomic === ZAPPER_QUOTE_ATOMIC) return "zapper_rich_tx_explainer";
  if (amountAtomic === PHASE2_QUOTE_ATOMIC) return "phase2_or_onesource";
  return "other";
}

function resolveReconciliationStatus(
  zapperEvents: readonly UsdcTransferEvent[],
): Pick<
  UsdcSettlementReconciliation,
  "settlement_reconciliation_status" | "reconciled_payment_count" | "reconciled_total_usdc"
> {
  const count = zapperEvents.length;
  const total = sumDecimal(zapperEvents.map((event) => event.amount_decimal));
  if (count === 0) {
    return {
      settlement_reconciliation_status: "NO_SETTLEMENT_FOUND_ONCHAIN",
      reconciled_payment_count: 0,
      reconciled_total_usdc: "0.000000",
    };
  }
  if (count === 2) {
    return {
      settlement_reconciliation_status: "SETTLEMENT_FOUND_BY_CHAIN_RECONCILIATION",
      reconciled_payment_count: 2,
      reconciled_total_usdc: total,
    };
  }
  if (count === 3) {
    return {
      settlement_reconciliation_status: "SETTLEMENT_FOUND_THREE_ATTEMPTS",
      reconciled_payment_count: 3,
      reconciled_total_usdc: total,
    };
  }
  return {
    settlement_reconciliation_status: "AMBIGUOUS_REQUIRES_MANUAL_REVIEW",
    reconciled_payment_count: count,
    reconciled_total_usdc: total,
  };
}

export async function reconcileUsdcSettlements(options: {
  readonly wallet: string;
  readonly fromBlock: number;
  readonly toBlock?: number | "latest";
  readonly fetchImpl?: typeof fetch;
  readonly blockTimestampResolver?: (
    blockNumber: number,
  ) => Promise<string | null> | string | null;
}): Promise<UsdcSettlementReconciliation> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wallet = options.wallet.toLowerCase();
  const toBlock = options.toBlock ?? "latest";
  const toBlockParam = toBlock === "latest" ? "latest" : `0x${toBlock.toString(16)}`;

  const logs = (await rpcFirst(fetchImpl, "eth_getLogs", [
    {
      address: USDC_BASE_ADDRESS,
      fromBlock: `0x${options.fromBlock.toString(16)}`,
      toBlock: toBlockParam,
      topics: [ERC20_TRANSFER_TOPIC, padTopicAddress(wallet)],
    },
  ])) as Array<{
    transactionHash?: string;
    blockNumber?: string;
    logIndex?: string;
    transactionIndex?: string;
    topics?: string[];
    data?: string;
  }>;

  const events: UsdcTransferEvent[] = [];
  for (const log of logs ?? []) {
    const amount = BigInt(`0x${(log.data ?? "0x0").slice(2).padStart(64, "0")}`);
    const blockNumber = Number.parseInt(log.blockNumber ?? "0x0", 16);
    let blockTimestampUtc: string | null = null;
    if (options.blockTimestampResolver) {
      blockTimestampUtc = await options.blockTimestampResolver(blockNumber);
    } else {
      try {
        const block = (await rpcFirst(fetchImpl, "eth_getBlockByNumber", [
          log.blockNumber,
          false,
        ])) as { timestamp?: string } | null;
        if (block?.timestamp) {
          blockTimestampUtc = new Date(Number.parseInt(block.timestamp, 16) * 1000).toISOString();
        }
      } catch {
        blockTimestampUtc = null;
      }
    }
    events.push({
      tx_hash: (log.transactionHash ?? "").toLowerCase(),
      block_number: blockNumber,
      block_timestamp_utc: blockTimestampUtc,
      from: topicAddress(log.topics?.[1]),
      to: topicAddress(log.topics?.[2]),
      amount_atomic: amount.toString(),
      amount_decimal: atomicToDecimal(amount),
      log_index: Number.parseInt(log.logIndex ?? "0x0", 16),
      transaction_index: Number.parseInt(log.transactionIndex ?? "0x0", 16),
      candidate_match: classifyCandidate(amount),
    });
  }

  events.sort((a, b) =>
    a.block_number === b.block_number
      ? a.log_index - b.log_index
      : a.block_number - b.block_number,
  );

  const zapperEvents = events.filter(
    (event) => event.candidate_match === "zapper_rich_tx_explainer",
  );
  const status = resolveReconciliationStatus(zapperEvents);

  return {
    wallet,
    token: USDC_BASE_ADDRESS,
    from_block: options.fromBlock,
    to_block: toBlock,
    events,
    zapper_candidate_count: zapperEvents.length,
    zapper_candidate_total_usdc: sumDecimal(zapperEvents.map((event) => event.amount_decimal)),
    ...status,
  };
}

export function parseReconcileCliArgs(argv: readonly string[]): {
  readonly wallet: string;
  readonly fromBlock?: number;
  readonly toBlock?: number | "latest";
  readonly out?: string;
} {
  let wallet = "";
  let fromBlock: number | undefined;
  let toBlock: number | "latest" | undefined;
  let out: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--wallet") {
      wallet = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--from-block") {
      fromBlock = Number.parseInt(argv[index + 1] ?? "", 10);
      index += 1;
      continue;
    }
    if (arg === "--to-block") {
      const value = argv[index + 1] ?? "";
      toBlock = value === "latest" ? "latest" : Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (arg === "--out") {
      out = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!wallet) throw new Error("missing required --wallet");
  return { wallet, fromBlock, toBlock, out };
}
