/**
 * verify-base-usdc-payment — on-chain settlement verification for Base USDC x402 probes.
 */

import { USDC_BASE_ADDRESS, ERC20_TRANSFER_TOPIC } from "./build-tx-ground-truth";

export type OnchainPaymentVerificationStatus =
  | "ONCHAIN_VERIFIED"
  | "ONCHAIN_FAILED"
  | "not_executed";

export interface OnchainPaymentVerification {
  readonly status: OnchainPaymentVerificationStatus;
  readonly transaction_hash: string | null;
  readonly chain_id: number | null;
  readonly usdc_transfer_found: boolean;
  readonly amount_atomic: string | null;
  readonly amount_decimal: string | null;
  readonly pay_to: string | null;
  readonly authorizer: string | null;
  readonly detail: string;
}

const DEFAULT_BASE_RPC = "https://mainnet.base.org";

function topicAddress(topic: string | undefined): string {
  if (!topic || !topic.startsWith("0x")) return "";
  const hex = topic.slice(2).padStart(64, "0");
  return `0x${hex.slice(24)}`.toLowerCase();
}

async function rpc(fetchImpl: typeof fetch, method: string, params: unknown[]): Promise<unknown> {
  const response = await fetchImpl(DEFAULT_BASE_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    redirect: "manual",
  });
  const body = (await response.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

function atomicToDecimal(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = amount % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

export async function verifyBaseUsdcPayment(options: {
  readonly transactionHash: string | null | undefined;
  readonly expectedAmountUsdc?: string | null;
  readonly expectedPayTo?: string | null;
  readonly fetchImpl?: typeof fetch;
}): Promise<OnchainPaymentVerification> {
  const tx = options.transactionHash?.trim().toLowerCase();
  if (!tx || !/^0x[0-9a-f]{64}$/.test(tx)) {
    return {
      status: "not_executed",
      transaction_hash: tx ?? null,
      chain_id: null,
      usdc_transfer_found: false,
      amount_atomic: null,
      amount_decimal: null,
      pay_to: null,
      authorizer: null,
      detail: "no payment transaction hash provided",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const chainIdHex = (await rpc(fetchImpl, "eth_chainId", [])) as string;
    const chain_id = Number.parseInt(chainIdHex, 16);
    const receipt = (await rpc(fetchImpl, "eth_getTransactionReceipt", [tx])) as {
      status?: string;
      logs?: Array<{ address?: string; topics?: string[]; data?: string }>;
    } | null;

    if (!receipt || receipt.status !== "0x1") {
      return {
        status: "ONCHAIN_FAILED",
        transaction_hash: tx,
        chain_id,
        usdc_transfer_found: false,
        amount_atomic: null,
        amount_decimal: null,
        pay_to: null,
        authorizer: null,
        detail: "receipt missing or not successful",
      };
    }

    let usdcTransfer: {
      from: string;
      to: string;
      amount_atomic: string;
      amount_decimal: string;
    } | null = null;

    for (const log of receipt.logs ?? []) {
      if ((log.topics?.[0] ?? "").toLowerCase() !== ERC20_TRANSFER_TOPIC) continue;
      if ((log.address ?? "").toLowerCase() !== USDC_BASE_ADDRESS.toLowerCase()) continue;
      const from = topicAddress(log.topics?.[1]);
      const to = topicAddress(log.topics?.[2]);
      const amount = BigInt(`0x${(log.data ?? "0x0").slice(2).padStart(64, "0")}`);
      usdcTransfer = {
        from,
        to,
        amount_atomic: amount.toString(),
        amount_decimal: atomicToDecimal(amount),
      };
      break;
    }

    if (!usdcTransfer) {
      return {
        status: "ONCHAIN_FAILED",
        transaction_hash: tx,
        chain_id,
        usdc_transfer_found: false,
        amount_atomic: null,
        amount_decimal: null,
        pay_to: null,
        authorizer: null,
        detail: "no USDC Transfer log found",
      };
    }

    if (
      options.expectedPayTo &&
      usdcTransfer.to !== options.expectedPayTo.toLowerCase()
    ) {
      return {
        status: "ONCHAIN_FAILED",
        transaction_hash: tx,
        chain_id,
        usdc_transfer_found: true,
        amount_atomic: usdcTransfer.amount_atomic,
        amount_decimal: usdcTransfer.amount_decimal,
        pay_to: usdcTransfer.to,
        authorizer: usdcTransfer.from,
        detail: `pay_to mismatch expected ${options.expectedPayTo}`,
      };
    }

    return {
      status: "ONCHAIN_VERIFIED",
      transaction_hash: tx,
      chain_id,
      usdc_transfer_found: true,
      amount_atomic: usdcTransfer.amount_atomic,
      amount_decimal: usdcTransfer.amount_decimal,
      pay_to: usdcTransfer.to,
      authorizer: usdcTransfer.from,
      detail: "USDC Transfer verified on Base mainnet",
    };
  } catch (error) {
    return {
      status: "ONCHAIN_FAILED",
      transaction_hash: tx,
      chain_id: null,
      usdc_transfer_found: false,
      amount_atomic: null,
      amount_decimal: null,
      pay_to: null,
      authorizer: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
