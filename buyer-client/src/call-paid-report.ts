/**
 * Agentic Payments Lab — buyer-client (MVP 001).
 *
 * Calls the seller's /paid/defi-risk-report endpoint and walks through the
 * x402 protocol. By default this script runs in **dry-run** mode: it issues
 * a plain unsigned request, expects HTTP 402, decodes the PAYMENT-REQUIRED
 * response header, prints the payment requirements, compares the required
 * amount against MAX_PAYMENT_USD, and exits without signing anything.
 *
 * A real testnet payment is only attempted when the user passes BOTH
 *   --pay
 * AND a valid BUYER_PRIVATE_KEY in .env. The buyer still refuses if the
 * server requires more than MAX_PAYMENT_USD, and the entire flow is locked
 * to Base Sepolia (X402_NETWORK=eip155:84532).
 *
 * Strictly testnet — no mainnet, no real funds.
 */

import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { loadEnvUnlessDisabled } from "./config/loadEnv";
import { writeBuyerAuditEvent } from "./observability/auditLogger";
import type { AuditPaymentSummary } from "./observability/auditTypes";

loadEnvUnlessDisabled();

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliFlags {
  dryRun: boolean;
  pay: boolean;
}

function parseFlags(argv: readonly string[]): CliFlags {
  const flags: CliFlags = { dryRun: false, pay: false };
  for (const arg of argv) {
    if (arg === "--dry-run") flags.dryRun = true;
    if (arg === "--pay") flags.pay = true;
  }
  // Default to dry-run unless --pay is explicitly set. --dry-run wins ties.
  if (!flags.pay) flags.dryRun = true;
  if (flags.pay && flags.dryRun) {
    // --dry-run beats --pay so users can never accidentally pay while still
    // typing --dry-run.
    flags.pay = false;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SELLER_BASE_URL = (
  process.env.SELLER_BASE_URL ?? "http://localhost:4021"
).replace(/\/+$/, "");
const MAX_PAYMENT_USD = Number.parseFloat(process.env.MAX_PAYMENT_USD ?? "0.001");
const EXPECTED_NETWORK = process.env.X402_NETWORK ?? "eip155:84532";
const PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY ?? "";

// USDC on Base Sepolia carries 6 decimals. This mirrors the asset metadata
// the seller advertises in the PAYMENT-REQUIRED header.
const USDC_DECIMALS = 6;

// ---------------------------------------------------------------------------
// Payment-requirements parsing
// ---------------------------------------------------------------------------

interface AcceptEntry {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  description?: string;
  mimeType?: string;
  extra?: { name?: string; version?: string };
}

interface PaymentRequiredEnvelope {
  x402Version?: number;
  error?: string;
  resource?: {
    url?: string;
    description?: string;
    mimeType?: string;
  };
  accepts?: AcceptEntry[];
}

function decodePaymentRequiredHeader(value: string): PaymentRequiredEnvelope {
  // The seller writes the requirements as base64-encoded JSON in the
  // PAYMENT-REQUIRED header. If decoding fails we surface the raw value so
  // operators can still diagnose by hand.
  try {
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    return JSON.parse(decoded) as PaymentRequiredEnvelope;
  } catch (error) {
    throw new Error(
      "Failed to decode PAYMENT-REQUIRED header.\n" +
        `Cause: ${(error as Error).message}`,
    );
  }
}

function atomicToUsd(amount: string | undefined, decimals: number): number {
  if (!amount) return Number.NaN;
  try {
    return Number(BigInt(amount)) / 10 ** decimals;
  } catch {
    return Number.NaN;
  }
}

function summarizeAccept(entry: AcceptEntry): string {
  const amount = entry.amount ?? entry.maxAmountRequired ?? "?";
  const usd = atomicToUsd(amount, USDC_DECIMALS);
  const usdLabel = Number.isFinite(usd) ? `≈ $${usd.toFixed(6)}` : "(unknown)";
  return [
    `  scheme:          ${entry.scheme ?? "?"}`,
    `  network:         ${entry.network ?? "?"}`,
    `  amount (atomic): ${amount}  ${usdLabel}`,
    `  asset:           ${entry.asset ?? "?"}`,
    `  payTo:           ${entry.payTo ?? "?"}`,
    `  maxTimeoutSecs:  ${entry.maxTimeoutSeconds ?? "?"}`,
    entry.extra?.name
      ? `  asset metadata:  ${entry.extra.name} v${entry.extra.version ?? "?"}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function paymentSummaryFromAccept(entry: AcceptEntry): AuditPaymentSummary {
  const amountAtomic = entry.amount ?? entry.maxAmountRequired;
  const amountUsd = atomicToUsd(amountAtomic, USDC_DECIMALS);
  return {
    network: entry.network,
    asset: entry.extra?.name ?? "USDC",
    amountAtomic,
    amountUsd: Number.isFinite(amountUsd) ? amountUsd.toString() : undefined,
    maxAmountUsd: MAX_PAYMENT_USD.toString(),
  };
}

// ---------------------------------------------------------------------------
// Buyer flows
// ---------------------------------------------------------------------------

const PAID_ROUTE = "/paid/defi-risk-report";
const REQUEST_PROTOCOL = process.env.BUYER_REPORT_PROTOCOL ?? "pancakeswap";
const REQUEST_CHAIN = process.env.BUYER_REPORT_CHAIN ?? "bsc";
const REQUEST_TOKEN_ID = process.env.BUYER_REPORT_TOKEN_ID ?? "demo-position-001";
const REQUEST_PAIR = process.env.BUYER_REPORT_PAIR;
const REQUEST_BODY = {
  wallet: "0x0000000000000000000000000000000000000000",
  position: {
    protocol: REQUEST_PROTOCOL,
    chain: REQUEST_CHAIN,
    tokenId: REQUEST_TOKEN_ID,
    ...(REQUEST_PAIR ? { pair: REQUEST_PAIR } : {}),
  },
};

async function preflightPaymentRequirements(requestId: string): Promise<{
  envelope: PaymentRequiredEnvelope;
  status: number;
  raw: string;
}> {
  const response = await fetch(`${SELLER_BASE_URL}${PAID_ROUTE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": requestId,
    },
    body: JSON.stringify(REQUEST_BODY),
  });
  if (response.status !== 402) {
    const body = await response.text();
    throw new Error(
      `Expected HTTP 402 from seller; got ${response.status}.\n` +
        `Body: ${body.slice(0, 500)}`,
    );
  }
  const raw = response.headers.get("payment-required") ?? "";
  if (!raw) {
    throw new Error(
      "Seller returned 402 but did not set the PAYMENT-REQUIRED header.",
    );
  }
  const envelope = decodePaymentRequiredHeader(raw);
  return { envelope, status: response.status, raw };
}

async function runDryRun(): Promise<number> {
  const requestId = randomUUID();
  console.log("[buyer-client] dry-run mode — no signing, no payment.");
  console.log(`[buyer-client] target: POST ${SELLER_BASE_URL}${PAID_ROUTE}`);
  console.log(`[buyer-client] MAX_PAYMENT_USD ceiling: $${MAX_PAYMENT_USD}`);
  await writeBuyerAuditEvent({
    eventType: "buyer.request_started",
    requestId,
    sellerBaseUrl: SELLER_BASE_URL,
    path: PAID_ROUTE,
    method: "POST",
    dryRun: true,
  });

  let envelope: PaymentRequiredEnvelope;
  let status: number;
  try {
    const result = await preflightPaymentRequirements(requestId);
    envelope = result.envelope;
    status = result.status;
  } catch (error) {
    await writeBuyerAuditEvent({
      eventType: "buyer.error",
      requestId,
      sellerBaseUrl: SELLER_BASE_URL,
      path: PAID_ROUTE,
      method: "POST",
      dryRun: true,
      outcome: "error",
      error: {
        message: (error as Error).message,
      },
    });
    throw error;
  }
  console.log(`[buyer-client] received HTTP ${status} as expected.`);

  const accepts = envelope.accepts ?? [];
  if (accepts.length === 0) {
    console.warn(
      "[buyer-client] WARNING: seller returned 402 with no accepts entries.",
    );
    return 2;
  }
  console.log("[buyer-client] payment requirements:");
  console.log("  x402Version:", envelope.x402Version ?? "(unset)");
  console.log("  resource:", JSON.stringify(envelope.resource ?? {}));
  for (const [index, entry] of accepts.entries()) {
    console.log(`  [accept ${index}]`);
    console.log(summarizeAccept(entry));
  }

  // Pick the cheapest entry on the expected network for the max-amount gate.
  const onNetwork = accepts.filter((a) => a.network === EXPECTED_NETWORK);
  if (onNetwork.length === 0) {
    console.error(
      `[buyer-client] no accept entry matches X402_NETWORK=${EXPECTED_NETWORK}; ` +
        "aborting (testnet-only safety).",
    );
    return 3;
  }
  const cheapest = onNetwork.reduce((a, b) => {
    const aUsd = atomicToUsd(a.amount ?? a.maxAmountRequired, USDC_DECIMALS);
    const bUsd = atomicToUsd(b.amount ?? b.maxAmountRequired, USDC_DECIMALS);
    return aUsd <= bUsd ? a : b;
  });
  const requiredUsd = atomicToUsd(
    cheapest.amount ?? cheapest.maxAmountRequired,
    USDC_DECIMALS,
  );
  const payment = paymentSummaryFromAccept(cheapest);
  await writeBuyerAuditEvent({
    eventType: "buyer.payment_requirements_received",
    requestId,
    sellerBaseUrl: SELLER_BASE_URL,
    path: PAID_ROUTE,
    method: "POST",
    dryRun: true,
    statusCode: status,
    payment,
  });
  console.log("[buyer-client] max-amount check:");
  console.log(`  required (USD ≈): $${requiredUsd.toFixed(6)}`);
  console.log(`  ceiling   (USD):  $${MAX_PAYMENT_USD}`);
  if (!Number.isFinite(requiredUsd)) {
    console.error("[buyer-client] required amount unparseable; refusing.");
    return 4;
  }
  if (requiredUsd > MAX_PAYMENT_USD) {
    console.error(
      "[buyer-client] required amount exceeds ceiling; refusing to pay even " +
        "if --pay had been set.",
    );
    return 5;
  }
  await writeBuyerAuditEvent({
    eventType: "buyer.dry_run_completed",
    requestId,
    sellerBaseUrl: SELLER_BASE_URL,
    path: PAID_ROUTE,
    method: "POST",
    dryRun: true,
    statusCode: status,
    payment,
    outcome: "dry_run_no_payment",
  });
  console.log("[buyer-client] dry-run OK. No payment attempted.");
  return 0;
}

async function runPay(): Promise<number> {
  const requestId = randomUUID();
  console.log("[buyer-client] --pay requested. Performing pre-flight first.");
  const { envelope } = await preflightPaymentRequirements(requestId);
  const accepts = envelope.accepts ?? [];
  const onNetwork = accepts.filter((a) => a.network === EXPECTED_NETWORK);
  if (onNetwork.length === 0) {
    console.error(
      `[buyer-client] seller does not offer ${EXPECTED_NETWORK}; refusing.`,
    );
    return 3;
  }
  const cheapest = onNetwork.reduce((a, b) => {
    const aUsd = atomicToUsd(a.amount ?? a.maxAmountRequired, USDC_DECIMALS);
    const bUsd = atomicToUsd(b.amount ?? b.maxAmountRequired, USDC_DECIMALS);
    return aUsd <= bUsd ? a : b;
  });
  const requiredUsd = atomicToUsd(
    cheapest.amount ?? cheapest.maxAmountRequired,
    USDC_DECIMALS,
  );
  if (!Number.isFinite(requiredUsd) || requiredUsd > MAX_PAYMENT_USD) {
    console.error(
      `[buyer-client] required $${requiredUsd} exceeds ceiling ` +
        `$${MAX_PAYMENT_USD}; refusing.`,
    );
    return 5;
  }
  if (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length < 66) {
    console.error(
      "[buyer-client] BUYER_PRIVATE_KEY is not set to a real testnet key. " +
        "Create a fresh Base Sepolia wallet, fund it with testnet USDC, and " +
        "set BUYER_PRIVATE_KEY in .env before retrying with --pay.",
    );
    return 6;
  }
  console.log("[buyer-client] signing one Base Sepolia testnet x402 payment…");
  const signer = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const response = await fetchWithPayment(`${SELLER_BASE_URL}${PAID_ROUTE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": requestId,
    },
    body: JSON.stringify(REQUEST_BODY),
  });
  console.log(`[buyer-client] final response HTTP ${response.status}`);
  const text = await response.text();
  console.log(text);
  return response.status >= 200 && response.status < 300 ? 0 : 7;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.pay) {
    process.exitCode = await runPay();
  } else {
    process.exitCode = await runDryRun();
  }
}

main().catch((error) => {
  console.error("[buyer-client] error:", (error as Error).message);
  process.exitCode = 1;
});
