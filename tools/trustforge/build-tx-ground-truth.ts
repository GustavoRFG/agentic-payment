/**
 * build-tx-ground-truth — independent Base/Ethereum tx facts via JSON-RPC.
 * No seller text; used as ground truth for rich tx_explainer verification.
 */

import { createHash } from "node:crypto";

export const USDC_BASE_ADDRESS =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
export const ERC20_TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as const;

export const DEFAULT_BASE_RPC_SOURCES = [
  "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
] as const;

export interface Erc20TransferFact {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly from: string;
  readonly to: string;
  readonly amount_atomic: string;
  readonly amount_decimal: string;
}

export interface TxGroundTruth {
  readonly chain_id: number;
  readonly tx_hash: string;
  readonly exists: boolean;
  readonly status: "success" | "reverted" | "unknown";
  readonly block_number: number;
  readonly from: string;
  readonly to: string;
  readonly gas_used: string;
  readonly effective_gas_price: string;
  readonly logs_count: number;
  readonly erc20_transfers: readonly Erc20TransferFact[];
  readonly created_at_utc: string;
}

interface RpcLog {
  readonly address?: string;
  readonly topics?: readonly string[];
  readonly data?: string;
}

interface RpcReceipt {
  readonly status?: string;
  readonly blockNumber?: string;
  readonly from?: string;
  readonly to?: string;
  readonly gasUsed?: string;
  readonly effectiveGasPrice?: string;
  readonly logs?: readonly RpcLog[];
}

interface RpcTransaction {
  readonly hash?: string;
  readonly blockNumber?: string;
  readonly from?: string;
  readonly to?: string;
}

function normalizeAddress(value: string | undefined): string {
  return (value ?? "").toLowerCase();
}

function normalizeHash(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(trimmed)) {
    throw new Error(`invalid tx hash: ${value}`);
  }
  return trimmed;
}

function hexToNumber(value: string | undefined): number {
  if (!value) return 0;
  return Number.parseInt(value, 16);
}

function atomicUsdcToDecimal(amountAtomic: bigint): string {
  const whole = amountAtomic / 1_000_000n;
  const frac = amountAtomic % 1_000_000n;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${fracStr}`;
}

function topicAddress(topic: string | undefined): string {
  if (!topic || !topic.startsWith("0x")) return "";
  const hex = topic.slice(2).padStart(64, "0");
  return normalizeAddress(`0x${hex.slice(24)}`);
}

function decodeErc20Transfers(
  logs: readonly RpcLog[] | undefined,
): Erc20TransferFact[] {
  const out: Erc20TransferFact[] = [];
  for (const log of logs ?? []) {
    const topic0 = (log.topics?.[0] ?? "").toLowerCase();
    if (topic0 !== ERC20_TRANSFER_TOPIC) continue;
    const token = normalizeAddress(log.address);
    const from = topicAddress(log.topics?.[1]);
    const to = topicAddress(log.topics?.[2]);
    const data = (log.data ?? "0x0").slice(2).padStart(64, "0");
    const amountAtomic = BigInt(`0x${data}`);
    const isUsdc = token === USDC_BASE_ADDRESS.toLowerCase();
    out.push({
      token,
      symbol: isUsdc ? "USDC" : "ERC20",
      decimals: isUsdc ? 6 : 18,
      from,
      to,
      amount_atomic: amountAtomic.toString(),
      amount_decimal: isUsdc
        ? atomicUsdcToDecimal(amountAtomic)
        : amountAtomic.toString(),
    });
  }
  return out;
}

async function rpcCall(
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
  if (!response.ok) {
    throw new Error(`${rpcUrl} HTTP ${response.status}`);
  }
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) {
    throw new Error(`${rpcUrl} rpc error ${JSON.stringify(body.error)}`);
  }
  return body.result;
}

export async function buildTxGroundTruth(options: {
  readonly txHash: string;
  readonly chain?: "base" | "ethereum";
  readonly chainId?: number;
  readonly rpcSources?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}): Promise<TxGroundTruth> {
  const tx_hash = normalizeHash(options.txHash);
  const chain = options.chain ?? "base";
  const chain_id =
    options.chainId ?? (chain === "base" ? 8453 : chain === "ethereum" ? 1 : 8453);
  const sources = options.rpcSources?.length
    ? options.rpcSources
    : chain === "base"
      ? DEFAULT_BASE_RPC_SOURCES
      : ["https://ethereum-rpc.publicnode.com"];
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  let lastError: string | undefined;
  for (const rpcUrl of sources) {
    try {
      const chainIdHex = (await rpcCall(fetchImpl, rpcUrl, "eth_chainId", [])) as string;
      const observedChainId = hexToNumber(chainIdHex);
      if (observedChainId !== chain_id) {
        throw new Error(`rpc chainId ${observedChainId} != expected ${chain_id}`);
      }

      const tx = (await rpcCall(fetchImpl, rpcUrl, "eth_getTransactionByHash", [
        tx_hash,
      ])) as RpcTransaction | null;
      if (!tx) {
        return {
          chain_id,
          tx_hash,
          exists: false,
          status: "unknown",
          block_number: 0,
          from: "",
          to: "",
          gas_used: "",
          effective_gas_price: "",
          logs_count: 0,
          erc20_transfers: [],
          created_at_utc: now().toISOString(),
        };
      }

      const receipt = (await rpcCall(fetchImpl, rpcUrl, "eth_getTransactionReceipt", [
        tx_hash,
      ])) as RpcReceipt | null;
      if (!receipt) {
        throw new Error("transaction exists but receipt missing");
      }

      const statusHex = receipt.status ?? "0x0";
      const status =
        statusHex === "0x1" ? "success" : statusHex === "0x0" ? "reverted" : "unknown";

      return {
        chain_id,
        tx_hash,
        exists: true,
        status,
        block_number: hexToNumber(receipt.blockNumber ?? tx.blockNumber),
        from: normalizeAddress(receipt.from ?? tx.from),
        to: normalizeAddress(receipt.to ?? tx.to),
        gas_used: receipt.gasUsed ?? "",
        effective_gas_price: receipt.effectiveGasPrice ?? "",
        logs_count: receipt.logs?.length ?? 0,
        erc20_transfers: decodeErc20Transfers(receipt.logs),
        created_at_utc: now().toISOString(),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  throw new Error(
    `buildTxGroundTruth failed for ${tx_hash}: ${lastError ?? "no rpc sources"}`,
  );
}

export function groundTruthSha256(groundTruth: TxGroundTruth): string {
  return createHash("sha256")
    .update(JSON.stringify(groundTruth), "utf8")
    .digest("hex");
}
