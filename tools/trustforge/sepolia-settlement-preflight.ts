/**
 * sepolia-settlement-preflight — read-only infra checks before testnet settlement.
 */

import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { baseSepolia } from "viem/chains";
import {
  PAYMENT_AMOUNT_USD,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import {
  SEPOLIA_CHAIN_ID,
  SEPOLIA_PROFILE,
  SEPOLIA_TESTNET_BUYER_WALLET,
  TRUSTFORGE_SEPOLIA_RPC_URL_ENV,
} from "./network-config";
import { assertMainnetBuyerKeyAbsent } from "./sepolia-settlement-guards";
import {
  probeSepoliaLocalSeller,
  type SepoliaSellerHandshakeResult,
} from "./sepolia-seller-handshake";

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type SepoliaPreflightBlocker =
  | "BLOCKED_SEPOLIA_RPC"
  | "BLOCKED_TESTNET_FUNDING"
  | "BLOCKED_SELLER_API"
  | "BLOCKED_MAINNET_KEY_PRESENT";

export interface SepoliaRpcHealthResult {
  readonly ok: boolean;
  readonly chainId: number | null;
  readonly latestBlock: bigint | null;
  readonly rpcRedacted: string;
  readonly detail: string;
}

export interface SepoliaWalletBalances {
  readonly address: typeof SEPOLIA_TESTNET_BUYER_WALLET;
  readonly ethBalance: string;
  readonly usdcBalance: string;
  readonly ethSufficient: boolean;
  readonly usdcSufficient: boolean;
  readonly requiredUsdc: string;
}

export interface SepoliaSettlementPreflightResult {
  readonly ok: boolean;
  readonly blocker: SepoliaPreflightBlocker | null;
  readonly rpc: SepoliaRpcHealthResult;
  readonly balances: SepoliaWalletBalances | null;
  readonly seller: SepoliaSellerHandshakeResult | null;
  readonly detail: string;
}

function redactRpc(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname && parsed.pathname !== "/"
      ? `${parsed.protocol}//${parsed.host}/...`
      : `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "invalid-rpc-url";
  }
}

function resolveSepoliaRpcUrl(env: Record<string, string | undefined>): string {
  return (
    env[TRUSTFORGE_SEPOLIA_RPC_URL_ENV]?.trim() ||
    env.BASE_SEPOLIA_RPC_URL?.trim() ||
    SEPOLIA_PROFILE.defaultRpcs[0]
  );
}

export async function checkSepoliaRpcHealth(input: {
  readonly rpcUrl: string;
}): Promise<SepoliaRpcHealthResult> {
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(input.rpcUrl),
  });
  try {
    const [chainId, blockNumber] = await Promise.all([
      client.getChainId(),
      client.getBlockNumber(),
    ]);
    if (chainId !== SEPOLIA_CHAIN_ID) {
      return {
        ok: false,
        chainId,
        latestBlock: blockNumber,
        rpcRedacted: redactRpc(input.rpcUrl),
        detail: `expected chainId ${SEPOLIA_CHAIN_ID}, got ${chainId}`,
      };
    }
    if (blockNumber <= 0n) {
      return {
        ok: false,
        chainId,
        latestBlock: blockNumber,
        rpcRedacted: redactRpc(input.rpcUrl),
        detail: "invalid latest block",
      };
    }
    return {
      ok: true,
      chainId,
      latestBlock: blockNumber,
      rpcRedacted: redactRpc(input.rpcUrl),
      detail: "eth_chainId/eth_blockNumber ok",
    };
  } catch (error) {
    return {
      ok: false,
      chainId: null,
      latestBlock: null,
      rpcRedacted: redactRpc(input.rpcUrl),
      detail: (error as Error).message.slice(0, 200),
    };
  }
}

export async function readSepoliaTestnetWalletBalances(input: {
  readonly rpcUrl: string;
  readonly requiredUsdc?: string;
}): Promise<SepoliaWalletBalances> {
  const required = input.requiredUsdc ?? PAYMENT_AMOUNT_USD;
  const client = createPublicClient({
    chain: baseSepolia,
    transport: http(input.rpcUrl),
  });
  const address = SEPOLIA_TESTNET_BUYER_WALLET as `0x${string}`;
  const [ethWei, usdcRaw] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: TESTNET_USDC_ADDRESS as `0x${string}`,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  const ethBalance = formatEther(ethWei);
  const usdcBalance = formatUnits(usdcRaw, 6);
  const requiredAtomic = BigInt(Math.floor(Number.parseFloat(required) * 1_000_000));
  return {
    address: SEPOLIA_TESTNET_BUYER_WALLET,
    ethBalance,
    usdcBalance,
    ethSufficient: ethWei > 0n,
    usdcSufficient: usdcRaw >= requiredAtomic,
    requiredUsdc: required,
  };
}

export async function runSepoliaSettlementPreflight(input: {
  readonly sellerBaseUrl?: string;
  readonly requiredUsdc?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
}): Promise<SepoliaSettlementPreflightResult> {
  const env = input.env ?? process.env;
  try {
    assertMainnetBuyerKeyAbsent(env);
  } catch {
    return {
      ok: false,
      blocker: "BLOCKED_MAINNET_KEY_PRESENT",
      rpc: {
        ok: false,
        chainId: null,
        latestBlock: null,
        rpcRedacted: "n/a",
        detail: "BUYER_PRIVATE_KEY present",
      },
      balances: null,
      seller: null,
      detail: "BUYER_PRIVATE_KEY must be absent",
    };
  }

  const rpcUrl = resolveSepoliaRpcUrl(env);
  const rpc = await checkSepoliaRpcHealth({ rpcUrl });
  if (!rpc.ok) {
    return {
      ok: false,
      blocker: "BLOCKED_SEPOLIA_RPC",
      rpc,
      balances: null,
      seller: null,
      detail: rpc.detail,
    };
  }

  const balances = await readSepoliaTestnetWalletBalances({
    rpcUrl,
    requiredUsdc: input.requiredUsdc,
  });
  if (!balances.ethSufficient || !balances.usdcSufficient) {
    return {
      ok: false,
      blocker: "BLOCKED_TESTNET_FUNDING",
      rpc,
      balances,
      seller: null,
      detail: `insufficient funding eth=${balances.ethBalance} usdc=${balances.usdcBalance}`,
    };
  }

  const sellerBaseUrl = input.sellerBaseUrl ?? env.SELLER_BASE_URL ?? "http://localhost:4021";
  let seller: SepoliaSellerHandshakeResult;
  try {
    seller = await probeSepoliaLocalSeller({ sellerBaseUrl, fetchImpl: input.fetchImpl });
  } catch (error) {
    return {
      ok: false,
      blocker: "BLOCKED_SELLER_API",
      rpc,
      balances,
      seller: null,
      detail: (error as Error).message,
    };
  }

  if (seller.outcome.status !== "live_402_ok" || !seller.accept) {
    return {
      ok: false,
      blocker: "BLOCKED_SELLER_API",
      rpc,
      balances,
      seller,
      detail: `seller handshake ${seller.outcome.status}`,
    };
  }
  if (seller.accept.network !== TESTNET_NETWORK) {
    return {
      ok: false,
      blocker: "BLOCKED_SELLER_API",
      rpc,
      balances,
      seller,
      detail: `seller network ${seller.accept.network} is not ${TESTNET_NETWORK}`,
    };
  }

  return {
    ok: true,
    blocker: null,
    rpc,
    balances,
    seller,
    detail: "Sepolia preflight pass",
  };
}
