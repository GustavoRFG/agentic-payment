/**
 * rich-tx-explainer-handshake — unpaid POST/GET x402 liveness (no wallet).
 */

import { createHash } from "node:crypto";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  atomicUsdcToDecimal,
  compareUsdcDecimal,
} from "./external-x402-get-policy";
import type { RichTxExplainerPolicy } from "./rich-tx-explainer-policy";

export interface RichTxExplainerHandshake {
  readonly policyId: string;
  readonly serviceId: string;
  readonly endpointUrl: string;
  readonly method: string;
  readonly httpStatus: number;
  readonly quoteUsdc: string;
  readonly network: string;
  readonly asset: string;
  readonly assetAddress: string | null;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly requestBody: unknown;
  readonly responseBodySha256: string;
  readonly responseHeadersSanitized: Record<string, string>;
  readonly responseBodySanitized: unknown;
  readonly observedAtUtc: string;
  readonly walletUsed: false;
  readonly paymentAttempted: false;
}

interface AcceptEntry {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo?: string;
  asset?: string;
  extra?: { name?: string; asset?: string };
}

interface PaymentEnvelope {
  accepts?: AcceptEntry[];
  x402Version?: number | string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function decodeHeader(headers: Record<string, string>): PaymentEnvelope | null {
  const direct =
    headers["payment-required"] ?? headers["x-payment-required"] ?? null;
  if (!direct) return null;
  try {
    return JSON.parse(
      direct.startsWith("{") ? direct : Buffer.from(direct, "base64").toString("utf8"),
    ) as PaymentEnvelope;
  } catch {
    return null;
  }
}

function selectAccept(policy: RichTxExplainerPolicy, envelope: PaymentEnvelope): AcceptEntry {
  const accepts = envelope.accepts ?? [];
  const match = accepts.filter(
    (a) =>
      a.network === policy.allowedNetwork &&
      (a.asset?.toLowerCase() === MAINNET_USDC_ADDRESS.toLowerCase() ||
        a.extra?.name === "USD Coin" ||
        a.extra?.name === "USDC"),
  );
  if (match.length === 0) throw new Error("no matching USDC accept on Base");
  const parsed = match
    .map((entry) => ({
      entry,
      quote: atomicUsdcToDecimal(entry.amount ?? entry.maxAmountRequired ?? "0"),
    }))
    .filter((x) => compareUsdcDecimal(x.quote, policy.maxPricePerCallUsdc) <= 0);
  if (parsed.length === 0) throw new Error("quote exceeds cap");
  const cheapest = parsed.reduce((a, b) =>
    compareUsdcDecimal(a.quote, b.quote) <= 0 ? a : b,
  );
  if (!cheapest.entry.payTo) throw new Error("missing payTo");
  return cheapest.entry;
}

export async function inspectRichTxExplainerUnpaidHandshake(
  policy: RichTxExplainerPolicy,
  options: {
    readonly txHash: string;
    readonly fetchImpl?: typeof fetch;
    readonly now?: () => Date;
    readonly timeoutMs?: number;
  },
): Promise<RichTxExplainerHandshake> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const requestBody = policy.buildRequestBody(options.txHash, policy.targetChainId);
  const url =
    policy.method === "GET" && policy.buildRequestUrl
      ? policy.buildRequestUrl(options.txHash, policy.targetChainId)
      : policy.endpointUrl;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  // Unref so the deadline timer can never hold the loop open into teardown (libuv async.c assert).
  (timer as { unref?: () => void }).unref?.();
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: policy.method,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: policy.method === "POST" ? JSON.stringify(requestBody) : undefined,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 200) {
    throw new Error("FREE_RESPONSE_NOT_X402_PAID_TARGET");
  }
  if (response.status !== 402) {
    throw new Error(`BLOCKED_EXTERNAL_LIVENESS: HTTP ${response.status}`);
  }

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const bodyText = await response.text();
  let bodyJson: unknown = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = { rawText: bodyText.slice(0, 2000) };
  }

  const headerEnvelope = decodeHeader(headers);
  const bodyEnvelope =
    bodyJson &&
    typeof bodyJson === "object" &&
    Array.isArray((bodyJson as PaymentEnvelope).accepts)
      ? (bodyJson as PaymentEnvelope)
      : null;
  const envelope = headerEnvelope ?? bodyEnvelope;
  if (!envelope) throw new Error("402 without parseable payment requirements");

  const accept = selectAccept(policy, envelope);
  const amountAtomic = accept.amount ?? accept.maxAmountRequired ?? "0";
  const quoteUsdc = atomicUsdcToDecimal(amountAtomic);

  const responseHeadersSanitized = { ...headers };
  for (const key of Object.keys(responseHeadersSanitized)) {
    if (key.includes("payment") || key === "authorization") {
      responseHeadersSanitized[key] = "[REDACTED]";
    }
  }

  return {
    policyId: policy.policyId,
    serviceId: policy.serviceId,
    endpointUrl: url,
    method: policy.method,
    httpStatus: 402,
    quoteUsdc,
    network: accept.network ?? policy.allowedNetwork,
    asset: policy.allowedAsset,
    assetAddress: accept.asset ?? MAINNET_USDC_ADDRESS,
    payTo: accept.payTo ?? "",
    amountAtomic,
    requestBody,
    responseBodySha256: sha256(bodyText),
    responseHeadersSanitized,
    responseBodySanitized: bodyJson,
    observedAtUtc: now().toISOString(),
    walletUsed: false,
    paymentAttempted: false,
  };
}
