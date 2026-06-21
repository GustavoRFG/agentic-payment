/**
 * x402-single-settlement-executor — promoted Sepolia-proven signing/send core.
 *
 * privateKeyToAccount, x402Client, registerExactEvmScheme, wrapFetchWithPayment
 * live ONLY here. Neither runner may duplicate them.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import { assertSettlementNetworkGuards } from "./settlement-network-guards";
import {
  buildSettlementIntent,
  type SettlementIntent,
} from "./settlement-run-binding";
import { parseJsonText } from "./bom-safe-json";

export interface SingleSettlementRequest {
  readonly network: string;
  readonly privateKeyEnvName: string;
  readonly expectedBuyerAddress: string;
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  readonly body?: unknown;
  readonly asset: string;
  readonly payTo: string;
  readonly quotedAmountAtomic: string;
  readonly maxAmountAtomic: string;
  readonly facilitatorUrl?: string;
  readonly runDir: string;
  readonly authorizationHash: string;
  readonly attemptId?: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly registerNetworks?: readonly string[];
  readonly require402BeforePayment?: boolean;
  readonly expectedNetworkIn402?: string;
}

export interface SingleSettlementExecutionResult {
  readonly ok: boolean;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly responseBody: string;
  readonly responseBodyPreview: string;
  readonly responseHeaders: Headers;
  readonly buyerAddress: string;
  readonly network: string;
  readonly facilitatorTransactionHash: string | null;
  readonly attemptId: string;
  readonly intent: SettlementIntent;
  readonly intentPath: string;
}

export interface PaymentRequiredIntentSpec {
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
}

export function decodePaymentRequiredHeader(value: string): { accepts?: Array<Record<string, unknown>> } {
  const decoded = Buffer.from(value, "base64").toString("utf-8");
  return parseJsonText<{ accepts?: Array<Record<string, unknown>> }>(decoded);
}

function acceptAmountAtomic(entry: Record<string, unknown>): string {
  return String(entry.amount ?? entry.maxAmountRequired ?? entry.maxAmount ?? "");
}

function acceptPayTo(entry: Record<string, unknown>): string {
  return String(entry.payTo ?? entry.pay_to ?? "").toLowerCase();
}

export function assertPaymentRequiredRailMatchesIntent(
  envelope: { accepts?: Array<Record<string, unknown>> },
  intent: PaymentRequiredIntentSpec,
  expectedNetwork?: string,
): void {
  const network = expectedNetwork ?? intent.network;
  const accepts = envelope.accepts ?? [];
  const rail = accepts.find((entry) => entry.network === network);
  if (!rail) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: network");
  }
  if (String(rail.asset ?? "").toLowerCase() !== intent.asset.toLowerCase()) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: asset");
  }
  if (acceptPayTo(rail) !== intent.payTo.toLowerCase()) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: pay_to");
  }
  if (acceptAmountAtomic(rail) !== intent.amountAtomic) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: amount");
  }
}

export function extractFacilitatorTransactionHash(response: Response): string | null {
  const paymentHeader =
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  if (!paymentHeader) return null;
  try {
    const padded = paymentHeader
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(paymentHeader.length / 4) * 4, "=");
    const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as Record<
      string,
      unknown
    >;
    const tx =
      decoded.transactionHash ??
      decoded.transaction_hash ??
      (decoded.transaction as Record<string, unknown> | undefined)?.hash;
    return typeof tx === "string" ? tx : null;
  } catch {
    return null;
  }
}

export async function persistSettlementIntent(
  runDir: string,
  intent: SettlementIntent,
): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, `settlement_intent_${intent.attempt_id}.json`);
  await writeFile(path, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
  return path;
}

export async function executeSingleX402Settlement(input: {
  readonly request: SingleSettlementRequest;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly paidInvocationGuard?: ReturnType<typeof createPaidInvocationGuard>;
  readonly paymentBearingGuard?: ReturnType<typeof createPaymentBearingRequestGuard>;
}): Promise<SingleSettlementExecutionResult> {
  const env = input.env ?? process.env;
  const req = input.request;
  const { privateKey, buyerAddress, chainId: _chainId } = assertSettlementNetworkGuards({
    network: req.network,
    privateKeyEnvName: req.privateKeyEnvName,
    expectedBuyerAddress: req.expectedBuyerAddress,
    asset: req.asset,
    env,
  });

  if (BigInt(req.quotedAmountAtomic) > BigInt(req.maxAmountAtomic)) {
    throw new Error(
      `BLOCKED_QUOTE_EXCEEDS_MAX: quote ${req.quotedAmountAtomic} > max ${req.maxAmountAtomic}`,
    );
  }

  const attemptId = req.attemptId ?? `attempt_${randomUUID()}`;
  const runId = req.runId ?? attemptId;
  const intent = buildSettlementIntent({
    attemptId,
    runId,
    authorizationHash: req.authorizationHash,
    network: req.network,
    buyer: buyerAddress,
    payTo: req.payTo,
    asset: req.asset,
    amountAtomic: req.quotedAmountAtomic,
  });
  const intentPath = await persistSettlementIntent(req.runDir, intent);

  const fetchImpl = input.fetchImpl ?? fetch;
  const requestId = req.requestId ?? randomUUID();
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (req.method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["X-Agentic-Request-Id"] = requestId;
  }

  if (req.require402BeforePayment) {
    const unpaid = await fetchImpl(req.endpoint, {
      method: req.method,
      headers,
      body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      redirect: "manual",
    });
    if (unpaid.status !== 402) {
      throw new Error(`BLOCKED_PRE_PAYMENT_402: expected 402, got ${unpaid.status}`);
    }
    const rawHeader =
      unpaid.headers.get("payment-required") ?? unpaid.headers.get("PAYMENT-REQUIRED");
    if (!rawHeader) {
      throw new Error("BLOCKED_PRE_PAYMENT_402: missing PAYMENT-REQUIRED header");
    }
    const envelope = decodePaymentRequiredHeader(rawHeader);
    assertPaymentRequiredRailMatchesIntent(
      envelope,
      {
        network: req.expectedNetworkIn402 ?? req.network,
        asset: req.asset,
        payTo: req.payTo,
        amountAtomic: req.quotedAmountAtomic,
      },
      req.expectedNetworkIn402 ?? req.network,
    );
  }

  const paidInvocationGuard =
    input.paidInvocationGuard ?? createPaidInvocationGuard({ maxAttempts: 1 });
  const paymentBearingGuard =
    input.paymentBearingGuard ?? createPaymentBearingRequestGuard({ maxPaymentBearingRequests: 1 });

  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const client = new x402Client();
  if (req.registerNetworks && req.registerNetworks.length > 0) {
    registerExactEvmScheme(client, {
      signer,
      networks: [...req.registerNetworks],
    });
  } else {
    registerExactEvmScheme(client, { signer });
  }

  const guardedFetch: typeof fetch = async (reqInput, init) => {
    paymentBearingGuard.inspectRequest(reqInput, init);
    return fetchImpl(reqInput, init);
  };
  const fetchWithPayment = wrapFetchWithPayment(guardedFetch, client);

  paidInvocationGuard.assertNext();
  const response = await fetchWithPayment(req.endpoint, {
    method: req.method,
    headers,
    body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
    redirect: "manual",
  });

  const body = await response.text();
  const paymentBearingCount = paymentBearingGuard.getPaymentBearingRequests();
  const ok = response.status >= 200 && response.status < 300;
  const facilitatorTransactionHash = extractFacilitatorTransactionHash(response);

  return {
    ok,
    status: ok ? "SETTLEMENT_HTTP_OK" : "SETTLEMENT_HTTP_FAIL",
    httpStatus: response.status,
    paymentAttempted: paymentBearingCount > 0,
    paymentBearingHttpRequestCount: paymentBearingCount,
    responseBody: body,
    responseBodyPreview: body.slice(0, 500),
    responseHeaders: response.headers,
    buyerAddress,
    network: req.network,
    facilitatorTransactionHash,
    attemptId,
    intent,
    intentPath,
  };
}
