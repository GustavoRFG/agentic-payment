/**
 * quote-stability-probe — second keyless 402 after the settle-method probe.
 *
 * Compares maxAmountRequired (atomic) across the method-probe 402 and a fresh
 * 402 on the same settle method/route. Divergence or zero rejects with
 * REJECTED_QUOTE_UNSTABLE so adapt can fall through to the next fallback.
 */

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS, TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { startAbortDeadline } from "./abort-deadline";

/** Keep aligned with paid-method-honored-probe / thin settlement (executor untouched). */
const SETTLEMENT_PAID_HTTP_METHOD = "POST" as const;

export const REJECTED_QUOTE_UNSTABLE = "REJECTED_QUOTE_UNSTABLE";

export interface QuoteStabilityEvidence {
  readonly first_max_amount_required_atomic: string | null;
  readonly second_max_amount_required_atomic: string | null;
}

export interface QuoteStabilityResult {
  readonly stable: boolean;
  readonly reason: string | null;
  readonly evidence: QuoteStabilityEvidence;
  readonly httpStatus: number | null;
  readonly walletUsed: false;
  readonly paymentAttempted: false;
}

interface AcceptEntry {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo?: string;
  extra?: Record<string, unknown>;
}

interface PaymentEnvelope {
  accepts?: AcceptEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function lowerHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function decodeJsonPossiblyBase64(value: string): PaymentEnvelope | null {
  const trimmed = value.trim();
  try {
    if (trimmed.startsWith("{")) return JSON.parse(trimmed) as PaymentEnvelope;
    const padded = trimmed
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(trimmed.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as PaymentEnvelope;
  } catch {
    return null;
  }
}

function envelopeFromHeaders(headers: Record<string, string>): PaymentEnvelope | null {
  const direct = headers["payment-required"] ?? headers["x-payment-required"];
  if (direct) return decodeJsonPossiblyBase64(direct);
  const wwwAuth = headers["www-authenticate"];
  const match = wwwAuth?.match(/requirements="([^"]+)"/i);
  if (match?.[1]) return decodeJsonPossiblyBase64(match[1]);
  return null;
}

function envelopeFromBody(body: unknown): PaymentEnvelope | null {
  if (!isRecord(body)) return null;
  if (Array.isArray(body.accepts)) return body as PaymentEnvelope;
  for (const key of ["paymentRequirements", "x402PaymentRequirements", "requirements"]) {
    const nested = body[key];
    if (isRecord(nested) && Array.isArray(nested.accepts)) {
      return nested as PaymentEnvelope;
    }
  }
  return null;
}

function parseAtomic(value: string | undefined): string | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return value;
}

function isUsdc(entry: AcceptEntry, expectedNetwork: string): boolean {
  const expectedUsdc =
    expectedNetwork === TESTNET_NETWORK ? TESTNET_USDC_ADDRESS : MAINNET_USDC_ADDRESS;
  const candidates = [
    entry.asset,
    entry.extra?.asset,
    entry.extra?.assetAddress,
    entry.extra?.tokenAddress,
    entry.extra?.currency,
  ];
  return candidates.some(
    (value) => typeof value === "string" && value.toLowerCase() === expectedUsdc.toLowerCase(),
  );
}

/**
 * Prefer maxAmountRequired; fall back to amount. Selects the cheapest USDC accept
 * on the expected network when multiple are present.
 */
export function extractMaxAmountRequiredAtomic(
  response: { readonly headers: Record<string, string>; readonly body: unknown },
  options: { readonly expectedNetwork?: string } = {},
): string | null {
  const expectedNetwork = options.expectedNetwork ?? MAINNET_NETWORK;
  const envelope = envelopeFromHeaders(response.headers) ?? envelopeFromBody(response.body);
  if (!envelope?.accepts?.length) return null;

  let best: { atomic: string; amount: bigint } | null = null;
  for (const entry of envelope.accepts) {
    if (entry.network !== expectedNetwork) continue;
    if (!isUsdc(entry, expectedNetwork)) continue;
    const atomic = parseAtomic(entry.maxAmountRequired ?? entry.amount);
    if (atomic === null) continue;
    const amount = BigInt(atomic);
    if (!best || amount < best.amount) best = { atomic, amount };
  }
  return best?.atomic ?? null;
}

export function evaluateQuoteStability(
  firstMaxAmountRequiredAtomic: string | null,
  secondMaxAmountRequiredAtomic: string | null,
): QuoteStabilityResult {
  const evidence: QuoteStabilityEvidence = {
    first_max_amount_required_atomic: firstMaxAmountRequiredAtomic,
    second_max_amount_required_atomic: secondMaxAmountRequiredAtomic,
  };

  const first = firstMaxAmountRequiredAtomic;
  const second = secondMaxAmountRequiredAtomic;
  if (!first || !second || !/^\d+$/.test(first) || !/^\d+$/.test(second)) {
    return {
      stable: false,
      reason: `${REJECTED_QUOTE_UNSTABLE}: first=${first ?? "null"} second=${second ?? "null"}`,
      evidence,
      httpStatus: null,
      walletUsed: false,
      paymentAttempted: false,
    };
  }

  // Divergence includes zero: any zero quote or unequal pair is unstable.
  if (first === "0" || second === "0" || first !== second) {
    return {
      stable: false,
      reason: `${REJECTED_QUOTE_UNSTABLE}: first=${first} second=${second}`,
      evidence,
      httpStatus: null,
      walletUsed: false,
      paymentAttempted: false,
    };
  }

  return {
    stable: true,
    reason: null,
    evidence,
    httpStatus: null,
    walletUsed: false,
    paymentAttempted: false,
  };
}

export async function fetchSettleMethod402MaxAmountRequiredAtomic(options: {
  readonly endpoint: string;
  readonly expectedNetwork?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly body?: unknown;
}): Promise<{
  readonly httpStatus: number | null;
  readonly maxAmountRequiredAtomic: string | null;
  readonly detail: string | null;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const deadline = startAbortDeadline(timeoutMs);
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (containsX402PaymentHeader(headers)) {
    deadline.clear();
    throw new Error("quote stability probe unexpectedly contains a payment header");
  }

  try {
    const response = await fetchImpl(options.endpoint, {
      method: SETTLEMENT_PAID_HTTP_METHOD,
      headers,
      body: JSON.stringify(options.body ?? {}),
      redirect: "manual",
      signal: deadline.signal,
    });
    const bodyText = await response.text();
    let body: unknown = null;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = { rawText: bodyText.slice(0, 2000) };
      }
    }
    const headerMap = lowerHeaders(response.headers);
    if (response.status !== 402) {
      return {
        httpStatus: response.status,
        maxAmountRequiredAtomic: null,
        detail: `expected HTTP 402, got ${response.status}`,
      };
    }
    return {
      httpStatus: response.status,
      maxAmountRequiredAtomic: extractMaxAmountRequiredAtomic(
        { headers: headerMap, body },
        { expectedNetwork: options.expectedNetwork },
      ),
      detail: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      httpStatus: null,
      maxAmountRequiredAtomic: null,
      detail: message,
    };
  } finally {
    deadline.clear();
  }
}

export async function probeQuoteStability(options: {
  readonly endpoint: string;
  readonly firstMaxAmountRequiredAtomic: string | null;
  readonly expectedNetwork?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly body?: unknown;
}): Promise<QuoteStabilityResult> {
  const second = await fetchSettleMethod402MaxAmountRequiredAtomic({
    endpoint: options.endpoint,
    expectedNetwork: options.expectedNetwork,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    body: options.body,
  });
  const evaluated = evaluateQuoteStability(
    options.firstMaxAmountRequiredAtomic,
    second.maxAmountRequiredAtomic,
  );
  if (!evaluated.stable) {
    return {
      ...evaluated,
      httpStatus: second.httpStatus,
      reason:
        evaluated.reason ??
        (second.detail
          ? `${REJECTED_QUOTE_UNSTABLE}: ${second.detail}`
          : `${REJECTED_QUOTE_UNSTABLE}: first=${options.firstMaxAmountRequiredAtomic ?? "null"} second=${second.maxAmountRequiredAtomic ?? "null"}`),
    };
  }
  return {
    ...evaluated,
    httpStatus: second.httpStatus,
  };
}
