import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { config as loadDotenv } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import {
  MAX_PAYMENT_ATTEMPTS,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";

const moduleDir = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(moduleDir, "..", ".env"), quiet: true });

const PAID_ROUTE = "/paid/analyze-text" as const;
const RESOURCE_SERVER_URL = (
  process.env.RESOURCE_SERVER_URL ?? "http://localhost:4021"
).replace(/\/+$/, "");
const MAX_PAYMENT_USD = Number.parseFloat(
  process.env.MAX_PAYMENT_USD ?? PAYMENT_AMOUNT_USD,
);
const BUYER_PRIVATE_KEY = process.env.BUYER_PRIVATE_KEY ?? "";
const USDC_DECIMALS = 6;

interface AcceptEntry {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  extra?: Record<string, unknown> & {
    name?: string;
    asset?: string;
    assetAddress?: string;
    tokenAddress?: string;
    contractAddress?: string;
  };
}

interface PaymentRequiredEnvelope {
  accepts?: AcceptEntry[];
}

interface SanitizedRequirements {
  endpoint: typeof PAID_ROUTE;
  network: typeof TESTNET_NETWORK;
  asset: "USDC";
  amountAtomic: string;
  amountUsd: string;
  paymentAttempted: false;
}

function safeJsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function assertGatewaySafety(): void {
  if (process.env.X402_USE_MAINNET === "1") {
    throw new Error("MVP 007A MCP gateway blocks mainnet payments.");
  }
  if (!Number.isFinite(MAX_PAYMENT_USD) || MAX_PAYMENT_USD > 0.001) {
    throw new Error("MAX_PAYMENT_USD must be set to 0.001 or lower.");
  }
}

function decodePaymentRequiredHeader(value: string): PaymentRequiredEnvelope {
  try {
    const decoded = Buffer.from(value, "base64").toString("utf-8");
    return JSON.parse(decoded) as PaymentRequiredEnvelope;
  } catch (error) {
    throw new Error(
      `Failed to decode PAYMENT-REQUIRED header: ${(error as Error).message}`,
    );
  }
}

function atomicUsdcToUsd(amount: string | undefined): string {
  if (!amount) return "";
  try {
    const atomic = BigInt(amount);
    const whole = atomic / 1_000_000n;
    const fractional = (atomic % 1_000_000n).toString().padStart(6, "0");
    return `${whole}.${fractional}`.replace(/\.?0+$/, "");
  } catch {
    return "";
  }
}

function paymentAssetAddress(entry: AcceptEntry): string | undefined {
  const candidates = [
    entry.asset,
    entry.extra?.asset,
    entry.extra?.assetAddress,
    entry.extra?.tokenAddress,
    entry.extra?.contractAddress,
  ];
  return candidates.find((value): value is string => {
    return typeof value === "string" && value.startsWith("0x");
  });
}

function isExpectedTestnetRail(entry: AcceptEntry): boolean {
  return (
    entry.network === TESTNET_NETWORK &&
    paymentAssetAddress(entry)?.toLowerCase() ===
      TESTNET_USDC_ADDRESS.toLowerCase()
  );
}

function selectRequirements(
  envelope: PaymentRequiredEnvelope,
): SanitizedRequirements {
  const accepts = envelope.accepts ?? [];
  const matching = accepts.filter(isExpectedTestnetRail);
  if (matching.length === 0) {
    throw new Error("Seller did not advertise the expected Base Sepolia USDC rail.");
  }

  const selected = matching.reduce((a, b) => {
    const aUsd = Number.parseFloat(
      atomicUsdcToUsd(a.amount ?? a.maxAmountRequired),
    );
    const bUsd = Number.parseFloat(
      atomicUsdcToUsd(b.amount ?? b.maxAmountRequired),
    );
    return aUsd <= bUsd ? a : b;
  });
  const amountAtomic = selected.amount ?? selected.maxAmountRequired ?? "";
  const amountUsd = atomicUsdcToUsd(amountAtomic);
  const parsedAmountUsd = Number.parseFloat(amountUsd);

  if (!amountAtomic || !Number.isFinite(parsedAmountUsd)) {
    throw new Error("Seller advertised an unparseable payment amount.");
  }
  if (parsedAmountUsd > MAX_PAYMENT_USD) {
    throw new Error("Seller advertised an amount above the configured ceiling.");
  }

  return {
    endpoint: PAID_ROUTE,
    network: TESTNET_NETWORK,
    asset: "USDC",
    amountAtomic,
    amountUsd,
    paymentAttempted: false,
  };
}

async function inspectAnalyzeTextPrice(text: string) {
  assertGatewaySafety();
  const response = await fetch(`${RESOURCE_SERVER_URL}${PAID_ROUTE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": randomUUID(),
    },
    body: JSON.stringify({ text, mode: "full" }),
  });

  if (response.status !== 402) {
    throw new Error(`Expected HTTP 402 from seller; got ${response.status}.`);
  }

  const paymentRequired = response.headers.get("payment-required");
  if (!paymentRequired) {
    throw new Error("Seller returned 402 without PAYMENT-REQUIRED.");
  }

  return selectRequirements(decodePaymentRequiredHeader(paymentRequired));
}

async function analyzeTextPaid(text: string) {
  assertGatewaySafety();

  const requirements = await inspectAnalyzeTextPrice(text);
  if (
    requirements.network !== TESTNET_NETWORK ||
    requirements.amountAtomic !== PAYMENT_AMOUNT_ATOMIC ||
    Number.parseFloat(requirements.amountUsd) > Number.parseFloat(PAYMENT_AMOUNT_USD)
  ) {
    throw new Error("Payment requirements do not match the approved testnet rail.");
  }
  if (!BUYER_PRIVATE_KEY.startsWith("0x") || BUYER_PRIVATE_KEY.length < 66) {
    throw new Error("BUYER_PRIVATE_KEY is not configured for paid invocation.");
  }

  const signer = privateKeyToAccount(BUYER_PRIVATE_KEY as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer, networks: [TESTNET_NETWORK] });

  const paidInvocationGuard = createPaidInvocationGuard(MAX_PAYMENT_ATTEMPTS);
  const paymentBearingGuard =
    createPaymentBearingRequestGuard(MAX_PAYMENT_ATTEMPTS);
  const guardedFetch: typeof fetch = async (input, init) => {
    paymentBearingGuard.inspectRequest(input, init);
    return fetch(input, init);
  };
  const fetchWithPayment = wrapFetchWithPayment(guardedFetch, client);

  paidInvocationGuard.assertNext();
  const response = await fetchWithPayment(`${RESOURCE_SERVER_URL}${PAID_ROUTE}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": randomUUID(),
    },
    body: JSON.stringify({ text, mode: "full" }),
  });

  if (paymentBearingGuard.getPaymentBearingRequests() > MAX_PAYMENT_ATTEMPTS) {
    throw new Error("Payment-bearing request cap exceeded.");
  }
  if (!response.ok) {
    throw new Error(`Paid endpoint returned HTTP ${response.status}.`);
  }

  return response.json() as Promise<unknown>;
}

assertGatewaySafety();

const server = new McpServer({
  name: "agentic-paid-tools",
  version: "0.1.0",
});

server.registerTool(
  "inspect_analyze_text_price",
  {
    title: "Inspect analyze-text x402 price",
    description:
      "Inspect /paid/analyze-text x402 payment requirements without signing or paying.",
    inputSchema: {
      text: z.string().min(1).max(2000),
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async ({ text }) => safeJsonResult(await inspectAnalyzeTextPrice(text)),
);

server.registerTool(
  "analyze_text_paid",
  {
    title: "Pay once for analyze-text",
    description:
      "Pay for and invoke /paid/analyze-text exactly once on Base Sepolia.",
    inputSchema: {
      text: z.string().min(1).max(2000),
      confirmation: z.literal("PAY_ONCE"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ text, confirmation }) => {
    if (confirmation !== "PAY_ONCE") {
      throw new Error("confirmation must equal PAY_ONCE.");
    }
    return safeJsonResult(await analyzeTextPaid(text));
  },
);

await server.connect(new StdioServerTransport());
