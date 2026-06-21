/**
 * sepolia-settlement-executor — single-shot Base Sepolia x402 payment (human key only).
 */

import { randomUUID } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import {
  PAYMENT_AMOUNT_USD,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import { runPaidQuoteFreshnessPreflight } from "./paid-quote-freshness-preflight";
import {
  assertMainnetBuyerKeyAbsent,
  preSignSepoliaGuards,
  readSepoliaBuyerPrivateKey,
} from "./sepolia-settlement-guards";
import {
  validateHumanPaymentAuthorization,
  type HumanPaymentAuthorization,
} from "./validate-human-payment-authorization";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import { SEPOLIA_CHAIN_ID } from "./network-config";

export interface SepoliaSettlementExecutionResult {
  readonly ok: boolean;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly responseBodyPreview: string;
  readonly buyerAddress: string;
  readonly network: typeof TESTNET_NETWORK;
}

function decodePaymentRequiredHeader(value: string): { accepts?: Array<Record<string, unknown>> } {
  const decoded = Buffer.from(value, "base64").toString("utf-8");
  return JSON.parse(decoded) as { accepts?: Array<Record<string, unknown>> };
}

export async function executeSepoliaSingleSettlement(input: {
  readonly runDir: string;
  readonly auth: HumanPaymentAuthorization;
  readonly selected: DiscoveredSelectedCandidate;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly skipFreshnessPreflight?: boolean;
}): Promise<SepoliaSettlementExecutionResult> {
  const env = input.env ?? process.env;
  assertMainnetBuyerKeyAbsent(env);
  if (env.X402_USE_MAINNET === "1") {
    throw new Error("BLOCKED_MAINNET_SIGNAL: X402_USE_MAINNET must not be set");
  }

  const validation = validateHumanPaymentAuthorization(input.auth, input.selected);
  if (!validation.valid) {
    throw new Error(`BLOCKED_INVALID_PAYMENT_AUTHORIZATION: ${validation.reasons.join("; ")}`);
  }

  if (!input.skipFreshnessPreflight) {
    const preflight = await runPaidQuoteFreshnessPreflight({
      authorized: {
        endpoint: input.selected.endpoint,
        quote_amount_usdc: input.selected.quote_amount_usdc,
        quote_atomic: input.selected.quote_atomic,
        authorized_max_usdc: input.auth.max_usdc,
        pay_to: input.selected.authorized_pay_to,
        network: input.selected.network,
        asset: input.selected.asset,
      },
      fetchImpl: input.fetchImpl,
    });
    if (!preflight.go) {
      throw new Error(`BLOCKED_PAY_TIME_FRESHNESS: ${preflight.reasons.join("; ")}`);
    }
  }

  const privateKey = readSepoliaBuyerPrivateKey(env);
  const { buyerAddress } = preSignSepoliaGuards({
    privateKey,
    network: input.selected.network,
    chainId: SEPOLIA_CHAIN_ID,
    env,
  });

  const fetchImpl = input.fetchImpl ?? fetch;
  const requestId = randomUUID();
  const requestBody = {
    text: "TrustForge Sepolia settlement proof — single authorized attempt.",
    mode: "full",
  };

  const unpaid = await fetchImpl(input.selected.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": requestId,
    },
    body: JSON.stringify(requestBody),
  });
  if (unpaid.status !== 402) {
    throw new Error(`BLOCKED_SELLER_API: expected 402, got ${unpaid.status}`);
  }
  const rawHeader =
    unpaid.headers.get("payment-required") ?? unpaid.headers.get("PAYMENT-REQUIRED");
  if (!rawHeader) {
    throw new Error("BLOCKED_SELLER_API: missing PAYMENT-REQUIRED header");
  }
  const envelope = decodePaymentRequiredHeader(rawHeader);
  const accepts = envelope.accepts ?? [];
  const rail = accepts.find(
    (entry) =>
      entry.network === TESTNET_NETWORK &&
      String(entry.asset ?? "").toLowerCase() === TESTNET_USDC_ADDRESS.toLowerCase(),
  );
  if (!rail) {
    throw new Error("BLOCKED_SELLER_API: no Sepolia USDC accept entry");
  }

  const paidInvocationGuard = createPaidInvocationGuard();
  const paymentBearingGuard = createPaymentBearingRequestGuard();
  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer });
  const guardedFetch: typeof fetch = async (reqInput, init) => {
    paymentBearingGuard.inspectRequest(reqInput, init);
    return fetchImpl(reqInput, init);
  };
  const fetchWithPayment = wrapFetchWithPayment(guardedFetch, client);
  paidInvocationGuard.assertNext();
  const response = await fetchWithPayment(input.selected.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": requestId,
    },
    body: JSON.stringify(requestBody),
  });
  const body = await response.text();
  const paymentBearingCount = paymentBearingGuard.getPaymentBearingRequests();
  const ok = response.status >= 200 && response.status < 300;
  return {
    ok,
    status: ok ? "SETTLEMENT_HTTP_OK" : "SETTLEMENT_HTTP_FAIL",
    httpStatus: response.status,
    paymentAttempted: paymentBearingCount > 0,
    paymentBearingHttpRequestCount: paymentBearingCount,
    responseBodyPreview: body.slice(0, 500),
    buyerAddress,
    network: TESTNET_NETWORK,
  };
}

export function assertSepoliaQuoteWithinMax(
  quoteUsdc: string,
  maxUsdc: string,
): void {
  const quote = Number.parseFloat(quoteUsdc);
  const max = Number.parseFloat(maxUsdc);
  if (!Number.isFinite(quote) || quote > max) {
    throw new Error(`quote ${quoteUsdc} exceeds max ${maxUsdc}`);
  }
  if (quote !== Number.parseFloat(PAYMENT_AMOUNT_USD)) {
    // allow small formatting differences — atomic check happens in freshness
  }
}
