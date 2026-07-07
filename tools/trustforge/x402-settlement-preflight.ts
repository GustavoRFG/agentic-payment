/**
 * x402-settlement-preflight — shared, network-parameterized, KEYLESS pre-settlement
 * verification for the thin x402 runner (Sepolia + mainnet).
 *
 * Fail-closed by construction. The default mode never loads a private key, never
 * creates an x402 client, never signs and never sends a payment-bearing request:
 * `payment_bearing_http_request_count` is 0 in every outcome, success or block.
 *
 * The optional `--verify-wallet-env` mode derives the buyer address from
 * BUYER_PRIVATE_KEY and compares it to the expected wallet. It still never
 * signs and never sends a payment-bearing request.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, formatEther, formatUnits, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import {
  MAINNET_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
} from "./network-config";
import {
  assertProfileEnvBeforeSettlement,
  expectedAssetForProfile,
  resolveX402SettlementProfileFromCli,
  type X402SettlementProfile,
} from "./x402-settlement-profile";
import { parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import {
  runPaidQuoteFreshnessPreflight,
  type AuthorizedPaymentQuote,
  type PaidQuoteFreshnessPreflightResult,
} from "./paid-quote-freshness-preflight";
import { ZAPPER_TX_EXPLAINER_POLICY } from "./rich-tx-explainer-policy";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";

export type X402PreflightBlocker =
  | "BLOCKED_WRONG_CHAIN"
  | "BLOCKED_WRONG_NETWORK"
  | "BLOCKED_WRONG_ASSET"
  | "BLOCKED_WRONG_WALLET_CONFIG"
  | "BLOCKED_WRONG_WALLET"
  | "BLOCKED_STALE_CANDIDATE"
  | "BLOCKED_402_ENDPOINT_MISMATCH"
  | "BLOCKED_402_PAY_TO_MISMATCH"
  | "BLOCKED_402_ASSET_MISMATCH"
  | "BLOCKED_402_AMOUNT_MISMATCH"
  | "BLOCKED_QUOTE_EXCEEDS_CAP"
  | "BLOCKED_RUN_ALREADY_CONSUMED"
  | "BLOCKED_RPC_TIMEOUT"
  | "BLOCKED_OPPOSITE_NETWORK_KEY";

/** RPC read result — chain id + read-only balances of the expected wallet. */
export interface ChainState {
  readonly chainId: number;
  readonly ethBalanceWei: bigint;
  readonly usdcAtomic: bigint;
  readonly rpcUsed: string;
}

export interface ChainStateReaderInput {
  readonly profile: X402SettlementProfile;
  readonly rpcUrls: readonly string[];
  readonly timeoutMs: number;
  readonly wallet: `0x${string}`;
}

export type ChainStateReader = (input: ChainStateReaderInput) => Promise<ChainState>;

/** Thrown by a chain-state reader when every configured RPC url times out. */
export class X402PreflightRpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "X402PreflightRpcTimeoutError";
  }
}

export interface X402PreflightResult {
  readonly ok: boolean;
  readonly blocker: X402PreflightBlocker | null;
  readonly mode: "keyless" | "verify-wallet-env";
  readonly network_profile: "mainnet" | "sepolia";
  readonly caip2: string;
  readonly chain_id_expected: number;
  readonly chain_id_observed: number | null;
  readonly asset_expected: string;
  readonly asset_candidate: string | null;
  readonly buyer_expected: string;
  readonly buyer_derived: string | null;
  readonly endpoint: string | null;
  readonly authorized_pay_to: string | null;
  readonly quote_atomic: string | null;
  readonly quote_amount_usdc: string | null;
  readonly recommended_max_usdc: string | null;
  readonly wallet_eth: string | null;
  readonly wallet_usdc: string | null;
  readonly candidate_belongs_to_run: boolean;
  readonly run_already_consumed: boolean;
  readonly fresh_402_go: boolean | null;
  readonly rpc_request_timeout_seconds: number;
  readonly rpc_fallback_configured: boolean;
  readonly rpc_silent_fallback: false;
  readonly buyer_private_key_present: boolean;
  readonly sepolia_buyer_private_key_present: boolean;
  readonly payment_bearing_http_request_count: 0;
  readonly strict_no_payment: "yes";
  readonly wallet_loaded: "no";
  readonly signed: false;
  readonly detail: string;
}

export interface X402PreflightOptions {
  readonly runDir: string;
  readonly network?: string;
  readonly verifyWalletEnv?: boolean;
  readonly rpcRequestTimeoutSeconds?: number;
  readonly candidateMaxAgeMinutes?: number;
  readonly env?: Record<string, string | undefined>;
  readonly now?: Date;
  readonly fetchImpl?: typeof fetch;
  // Injectable seams (tests drive these without touching the network):
  readonly chainStateReader?: ChainStateReader;
  readonly freshness?: (quote: AuthorizedPaymentQuote) => Promise<PaidQuoteFreshnessPreflightResult>;
  readonly loadCandidate?: () => DiscoveredSelectedCandidate | null;
}

const CONSUMED_PREFIXES = ["settlement_intent_", "settlement_binding_", "facilitator_receipt_"];
const CONSUMED_EXACT = [
  "human_payment_authorization.json",
  "x402_classification.json",
  "sepolia_classification.json",
];
const CONSUMED_DIRS = ["settlement_probe"];

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function resolveRpcUrls(
  profile: X402SettlementProfile,
  env: Record<string, string | undefined>,
): { readonly urls: string[]; readonly fallbackConfigured: boolean } {
  // Documented default primary; NOT a silent rotation target.
  const primaryEnv = profile.id === "mainnet" ? "TRUSTFORGE_BASE_RPC_URL" : "TRUSTFORGE_SEPOLIA_RPC_URL";
  const fallbackEnv =
    profile.id === "mainnet" ? "TRUSTFORGE_BASE_RPC_FALLBACK_URLS" : "TRUSTFORGE_SEPOLIA_RPC_FALLBACK_URLS";
  const primary = env[primaryEnv]?.trim() || defaultPrimaryRpc(profile);
  const fallbacks = (env[fallbackEnv]?.trim() ?? "")
    .split(/[\s,]+/)
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 3);
  return { urls: [primary, ...fallbacks], fallbackConfigured: fallbacks.length > 0 };
}

function defaultPrimaryRpc(profile: X402SettlementProfile): string {
  return profile.id === "mainnet" ? "https://mainnet.base.org" : "https://sepolia.base.org";
}

/**
 * Default chain-state reader: tries each url in order (primary then EXPLICIT
 * fallbacks only), each bounded by an explicit timeout with retries disabled.
 * There is no silent rotation to any other endpoint.
 */
export const readBaseChainStateViaViem: ChainStateReader = async (input) => {
  const chain = input.profile.id === "mainnet" ? base : baseSepolia;
  let lastError: Error | null = null;
  for (const rpcUrl of input.rpcUrls) {
    try {
      const client = createPublicClient({
        chain,
        transport: http(rpcUrl, { timeout: input.timeoutMs, retryCount: 0 }),
      });
      const [chainId, ethBalanceWei, usdcAtomic] = await Promise.all([
        client.getChainId(),
        client.getBalance({ address: input.wallet }),
        client.readContract({
          address: input.profile.usdcContract as `0x${string}`,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.wallet],
        }),
      ]);
      return { chainId, ethBalanceWei, usdcAtomic: usdcAtomic as bigint, rpcUsed: rpcUrl };
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new X402PreflightRpcTimeoutError(
    `all configured RPC urls failed (${input.rpcUrls.length}): ${lastError?.message ?? "unknown"}`,
  );
};

function detectRunConsumed(runDir: string): boolean {
  if (!existsSync(runDir)) return false;
  const entries = readdirSync(runDir);
  for (const name of entries) {
    if (CONSUMED_EXACT.includes(name)) return true;
    if (CONSUMED_DIRS.includes(name)) return true;
    if (CONSUMED_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
  }
  return false;
}

function defaultLoadCandidate(runDir: string): DiscoveredSelectedCandidate | null {
  const path = join(runDir, "selected_candidate.json");
  if (!existsSync(path)) return null;
  return readJsonFileSync<DiscoveredSelectedCandidate>(path);
}

// bom-safe-json exposes an async reader; the preflight only needs a small sync read.
function readJsonFileSync<T>(path: string): T {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  return JSON.parse(raw) as T;
}

function mapFreshnessReasonsToBlocker(reasons: readonly string[]): X402PreflightBlocker {
  const joined = reasons.join(" | ").toLowerCase();
  if (joined.includes("payto mismatch")) return "BLOCKED_402_PAY_TO_MISMATCH";
  if (joined.includes("wrong asset")) return "BLOCKED_402_ASSET_MISMATCH";
  if (
    joined.includes("quote drift") ||
    joined.includes("exceeds authorized") ||
    joined.includes("amount")
  ) {
    return "BLOCKED_402_AMOUNT_MISMATCH";
  }
  if (joined.includes("wrong network")) return "BLOCKED_WRONG_NETWORK";
  if (joined.includes("not allowlisted") || joined.includes("endpoint") || joined.includes("resourceurl")) {
    return "BLOCKED_402_ENDPOINT_MISMATCH";
  }
  return "BLOCKED_STALE_CANDIDATE";
}

function block(
  base: Omit<X402PreflightResult, "ok" | "blocker" | "detail">,
  blocker: X402PreflightBlocker,
  detail: string,
): X402PreflightResult {
  return { ...base, ok: false, blocker, detail };
}

/**
 * verify-wallet-env — human-gated OPTIONAL mode. Requires ONLY BUYER_PRIVATE_KEY,
 * refuses SEPOLIA_BUYER_PRIVATE_KEY, derives the address and compares it to the
 * expected wallet. Never creates an x402 client, never signs, never sends a
 * payment-bearing request.
 */
export function runX402WalletEnvVerification(input: {
  readonly profile: X402SettlementProfile;
  readonly env?: Record<string, string | undefined>;
}): { readonly ok: boolean; readonly blocker: X402PreflightBlocker | null; readonly derived: string | null; readonly detail: string } {
  const env = input.env ?? process.env;
  if (env[SEPOLIA_BUYER_PRIVATE_KEY_ENV]?.trim()) {
    return {
      ok: false,
      blocker: "BLOCKED_OPPOSITE_NETWORK_KEY",
      derived: null,
      detail: "SEPOLIA_BUYER_PRIVATE_KEY must be absent for the mainnet wallet gate",
    };
  }
  const key = env[MAINNET_BUYER_PRIVATE_KEY_ENV]?.trim() ?? "";
  if (!key) {
    return {
      ok: false,
      blocker: "BLOCKED_WRONG_WALLET_CONFIG",
      derived: null,
      detail: "BUYER_PRIVATE_KEY absent — cannot verify wallet",
    };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    return {
      ok: false,
      blocker: "BLOCKED_WRONG_WALLET_CONFIG",
      derived: null,
      detail: "BUYER_PRIVATE_KEY format invalid",
    };
  }
  const derived = privateKeyToAccount(key as `0x${string}`).address;
  if (derived.toLowerCase() !== input.profile.buyerWallet.toLowerCase()) {
    return {
      ok: false,
      blocker: "BLOCKED_WRONG_WALLET",
      derived,
      detail: `derived ${derived} != expected ${input.profile.buyerWallet}`,
    };
  }
  return { ok: true, blocker: null, derived, detail: "wallet matches expected buyer" };
}

export async function runX402SettlementPreflight(
  options: X402PreflightOptions,
): Promise<X402PreflightResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const timeoutSeconds = options.rpcRequestTimeoutSeconds ?? 20;
  const candidateMaxAgeMinutes = options.candidateMaxAgeMinutes ?? 180;

  const candidate = options.loadCandidate
    ? options.loadCandidate()
    : defaultLoadCandidate(options.runDir);

  const profile = resolveX402SettlementProfileFromCli(options.network, candidate?.network);
  const rpc = resolveRpcUrls(profile, env);
  const buyerKeyPresent = Boolean(env[MAINNET_BUYER_PRIVATE_KEY_ENV]?.trim());
  const sepoliaKeyPresent = Boolean(env[SEPOLIA_BUYER_PRIVATE_KEY_ENV]?.trim());

  const baseResult: Omit<X402PreflightResult, "ok" | "blocker" | "detail"> = {
    mode: options.verifyWalletEnv ? "verify-wallet-env" : "keyless",
    network_profile: profile.id,
    caip2: profile.caip2,
    chain_id_expected: profile.chainId,
    chain_id_observed: null,
    asset_expected: expectedAssetForProfile(profile),
    asset_candidate: candidate?.asset ?? null,
    buyer_expected: profile.buyerWallet,
    buyer_derived: null,
    endpoint: candidate?.endpoint ?? null,
    authorized_pay_to: candidate?.authorized_pay_to ?? null,
    quote_atomic: candidate?.quote_atomic ?? null,
    quote_amount_usdc: candidate?.quote_amount_usdc ?? null,
    recommended_max_usdc: candidate?.recommended_max_usdc ?? null,
    wallet_eth: null,
    wallet_usdc: null,
    candidate_belongs_to_run: false,
    run_already_consumed: false,
    fresh_402_go: null,
    rpc_request_timeout_seconds: timeoutSeconds,
    rpc_fallback_configured: rpc.fallbackConfigured,
    rpc_silent_fallback: false,
    buyer_private_key_present: buyerKeyPresent,
    sepolia_buyer_private_key_present: sepoliaKeyPresent,
    payment_bearing_http_request_count: 0,
    strict_no_payment: "yes",
    wallet_loaded: "no",
    signed: false,
  };

  // (0) Optional human wallet gate — explicit, no-sign, no payment.
  if (options.verifyWalletEnv) {
    const verify = runX402WalletEnvVerification({ profile, env });
    const withDerived = { ...baseResult, buyer_derived: verify.derived };
    if (!verify.ok) return block(withDerived, verify.blocker!, verify.detail);
    return { ...withDerived, ok: true, blocker: null, detail: `verify-wallet-env: ${verify.detail}` };
  }

  // (1) Opposite-network key must be absent (fail-closed before anything else).
  try {
    assertProfileEnvBeforeSettlement(profile, env);
  } catch (error) {
    return block(baseResult, "BLOCKED_OPPOSITE_NETWORK_KEY", (error as Error).message);
  }

  // (2) Candidate must exist and belong to this run.
  if (!candidate) {
    return block(baseResult, "BLOCKED_STALE_CANDIDATE", "selected_candidate.json missing in run dir");
  }
  const targetSelectionPath = join(options.runDir, "target_selection.json");
  if (existsSync(targetSelectionPath)) {
    const selection = readJsonFileSync<{ selection?: { primary?: { resourceUrl?: string } } }>(
      targetSelectionPath,
    );
    const primaryUrl = selection.selection?.primary?.resourceUrl;
    if (primaryUrl && primaryUrl !== candidate.endpoint) {
      return block(
        baseResult,
        "BLOCKED_STALE_CANDIDATE",
        `candidate endpoint ${candidate.endpoint} does not match run target_selection ${primaryUrl}`,
      );
    }
  }
  const belongs = { ...baseResult, candidate_belongs_to_run: true };

  // (3) Run must not already contain an authorization/attempt/binding/receipt.
  const consumed = detectRunConsumed(options.runDir);
  const withConsumed = { ...belongs, run_already_consumed: consumed };
  if (consumed) {
    return block(
      withConsumed,
      "BLOCKED_RUN_ALREADY_CONSUMED",
      "run already contains authorization/attempt/binding/receipt/classification",
    );
  }

  // (4) Candidate freshness (age) — a stale candidate never reaches payment.
  const selectedAtMs = Date.parse(candidate.selected_at_utc ?? "");
  if (Number.isNaN(selectedAtMs)) {
    return block(withConsumed, "BLOCKED_STALE_CANDIDATE", "candidate missing selected_at_utc");
  }
  if (now.getTime() - selectedAtMs > candidateMaxAgeMinutes * 60_000) {
    return block(
      withConsumed,
      "BLOCKED_STALE_CANDIDATE",
      `candidate selected_at ${candidate.selected_at_utc} older than ${candidateMaxAgeMinutes}m`,
    );
  }

  // (5) Static candidate field gates (no network).
  if (candidate.network !== profile.caip2) {
    return block(withConsumed, "BLOCKED_WRONG_NETWORK", `candidate network ${candidate.network} != ${profile.caip2}`);
  }
  if ((candidate.asset ?? "").toLowerCase() !== expectedAssetForProfile(profile).toLowerCase()) {
    return block(withConsumed, "BLOCKED_WRONG_ASSET", `candidate asset ${candidate.asset} != ${expectedAssetForProfile(profile)}`);
  }
  if ((candidate.buyer_wallet ?? "").toLowerCase() !== profile.buyerWallet.toLowerCase()) {
    return block(
      withConsumed,
      "BLOCKED_WRONG_WALLET_CONFIG",
      `candidate buyer ${candidate.buyer_wallet} != ${profile.buyerWallet}`,
    );
  }
  if (!candidate.authorized_pay_to?.trim()) {
    return block(withConsumed, "BLOCKED_STALE_CANDIDATE", "candidate authorized_pay_to is empty");
  }
  if (profile.id === "mainnet" && candidate.endpoint !== ZAPPER_TX_EXPLAINER_POLICY.endpointUrl) {
    return block(
      withConsumed,
      "BLOCKED_402_ENDPOINT_MISMATCH",
      `mainnet candidate endpoint ${candidate.endpoint} != ${ZAPPER_TX_EXPLAINER_POLICY.endpointUrl}`,
    );
  }
  const quoteAtomic = candidate.quote_atomic?.trim() ?? "";
  if (!/^\d+$/.test(quoteAtomic)) {
    return block(withConsumed, "BLOCKED_STALE_CANDIDATE", `candidate quote_atomic invalid: ${quoteAtomic}`);
  }
  const capAtomic = candidate.recommended_max_usdc
    ? parseUsdcDecimalToAtomic(candidate.recommended_max_usdc)
    : 0n;
  if (capAtomic < BigInt(quoteAtomic)) {
    return block(
      withConsumed,
      "BLOCKED_QUOTE_EXCEEDS_CAP",
      `quote ${quoteAtomic} exceeds recommended cap ${capAtomic.toString()}`,
    );
  }

  // (6) RPC — chain id + read-only balances (keyless, explicit timeout, no silent fallback).
  const reader = options.chainStateReader ?? readBaseChainStateViaViem;
  let chainState: ChainState;
  try {
    chainState = await reader({
      profile,
      rpcUrls: rpc.urls,
      timeoutMs: timeoutSeconds * 1000,
      wallet: profile.buyerWallet as `0x${string}`,
    });
  } catch (error) {
    if (error instanceof X402PreflightRpcTimeoutError) {
      return block(withConsumed, "BLOCKED_RPC_TIMEOUT", error.message);
    }
    return block(withConsumed, "BLOCKED_RPC_TIMEOUT", (error as Error).message);
  }
  const withChain = {
    ...withConsumed,
    chain_id_observed: chainState.chainId,
    wallet_eth: formatEther(chainState.ethBalanceWei),
    wallet_usdc: formatUnits(chainState.usdcAtomic, 6),
  };
  if (chainState.chainId !== profile.chainId) {
    return block(
      withChain,
      "BLOCKED_WRONG_CHAIN",
      `RPC returned chainId ${chainState.chainId}, expected ${profile.chainId}`,
    );
  }

  // (7) Unsigned 402 re-handshake — network/asset/payTo/amount + freshness match candidate.
  const authorizedQuote: AuthorizedPaymentQuote = {
    endpoint: candidate.endpoint,
    quote_amount_usdc: candidate.quote_amount_usdc,
    quote_atomic: candidate.quote_atomic,
    authorized_max_usdc: candidate.recommended_max_usdc,
    pay_to: candidate.authorized_pay_to,
    network: candidate.network,
    asset: candidate.asset,
  };
  const freshnessFn =
    options.freshness ??
    ((quote: AuthorizedPaymentQuote) =>
      runPaidQuoteFreshnessPreflight({ authorized: quote, fetchImpl: options.fetchImpl, now }));
  const fresh = await freshnessFn(authorizedQuote);
  const withFresh = { ...withChain, fresh_402_go: fresh.go };
  if (!fresh.go) {
    return block(withFresh, mapFreshnessReasonsToBlocker(fresh.reasons), `fresh 402 mismatch: ${fresh.reasons.join("; ")}`);
  }

  return {
    ...withFresh,
    ok: true,
    blocker: null,
    detail: `${profile.id} keyless preflight pass — human wallet gate + authorization still required`,
  };
}
