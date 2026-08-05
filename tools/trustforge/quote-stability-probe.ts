/**
 * quote-stability-probe — second keyless 402 after the settle-method probe.
 *
 * Compares the atomic quote across the method-probe 402 and a fresh 402 on the
 * same settle method/route. Stability means equality only. Missing/invalid
 * extraction and stable-but-non-positive acceptability are classified separately.
 */

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS, TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { startAbortDeadline } from "./abort-deadline";
import { planThinSettleRequest } from "./thin-settlement-method-contract";
import type { ThinSettlementRequestBinding } from "./thin-settlement-request-binding";
import {
  parseAndBindSellerPaymentRequirements,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";

export const REJECTED_QUOTE_UNSTABLE = "REJECTED_QUOTE_UNSTABLE";
/** One or both 402 responses did not yield a valid unsigned integer atomic quote. */
export const REJECTED_QUOTE_EXTRACTION_FAILED = "REJECTED_QUOTE_EXTRACTION_FAILED";
/** Equal live quotes were extracted, but their atomic value is not positive. */
export const REJECTED_NON_POSITIVE_QUOTE = "REJECTED_NON_POSITIVE_QUOTE";
/** The live 402 the stability probe read disagrees with the catalog/census quote. */
export const REJECTED_QUOTE_SOURCE_DISAGREEMENT = "REJECTED_QUOTE_SOURCE_DISAGREEMENT";
/** @deprecated Reserved for explicitly typed proprietary adapters only. */
export const REJECTED_INCOMPLETE_402_CHALLENGE = "REJECTED_INCOMPLETE_402_CHALLENGE";

export interface QuoteStabilityEvidence {
  readonly first_max_amount_required_atomic: string | null;
  readonly second_max_amount_required_atomic: string | null;
}

/**
 * The quote read from a single live 402 response: the atomic amount and canonical
 * seller requirements binding. Adapt binds the persisted
 * quote_atomic to this — never to catalog/census/cache.
 */
export interface BoundQuote {
  readonly atomic: string | null;
  readonly sellerRequirements: SellerRequirementsObservation | null;
  readonly sellerRequirementsError: string | null;
  /** @deprecated Seller requirements do not own the EIP-3009 nonce. */
  readonly nonce: string | null;
  /** @deprecated Seller requirements do not define expiresAt in x402 v1/v2. */
  readonly expiresAt: string | null;
  readonly rawSourceField: "maxAmountRequired" | "amount" | null;
  readonly rawSourceValue: string | null;
}

export interface QuoteStabilityResult {
  readonly stable: boolean;
  readonly reason: string | null;
  readonly evidence: QuoteStabilityEvidence;
  /** The quote bound to the stability probe's live 402 (its second, freshest read). */
  readonly bound: BoundQuote;
  readonly httpStatus: number | null;
  readonly walletUsed: false;
  readonly paymentAttempted: false;
}

interface AcceptEntry {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: unknown;
  maxAmountRequired?: unknown;
  payTo?: string;
  nonce?: unknown;
  expiresAt?: unknown;
  extra?: Record<string, unknown>;
}

interface PaymentEnvelope {
  accepts?: AcceptEntry[];
  nonce?: unknown;
  expiresAt?: unknown;
}

const EMPTY_BOUND_QUOTE: BoundQuote = {
  atomic: null,
  sellerRequirements: null,
  sellerRequirementsError: null,
  nonce: null,
  expiresAt: null,
  rawSourceField: null,
  rawSourceValue: null,
};

interface RawAtomicQuoteSource {
  readonly field: "maxAmountRequired" | "amount";
  readonly value: unknown;
}

interface SelectedUsdcAccept {
  readonly entry: AcceptEntry;
  readonly atomic: string;
  readonly rawSource: RawAtomicQuoteSource;
}

interface UsdcAcceptSelection {
  readonly selected: SelectedUsdcAccept | null;
  /** First matching USDC source, retained when its value cannot be parsed. */
  readonly diagnosticSource: RawAtomicQuoteSource | null;
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

function parseAtomic(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  return value;
}

function rawAtomicQuoteSource(entry: AcceptEntry): RawAtomicQuoteSource | null {
  if (entry.maxAmountRequired !== null && entry.maxAmountRequired !== undefined) {
    return { field: "maxAmountRequired", value: entry.maxAmountRequired };
  }
  if (entry.amount !== null && entry.amount !== undefined) {
    return { field: "amount", value: entry.amount };
  }
  return null;
}

function displayRawSourceValue(source: RawAtomicQuoteSource | null): string | null {
  if (!source || source.value === null || source.value === undefined) return null;
  if (typeof source.value === "string") return source.value;
  return JSON.stringify(source.value) ?? String(source.value);
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

/** Cheapest USDC accept on the expected network, with its parsed atomic amount. */
function selectCheapestUsdcAccept(
  envelope: PaymentEnvelope,
  expectedNetwork: string,
): UsdcAcceptSelection {
  let best: (SelectedUsdcAccept & { readonly amount: bigint }) | null = null;
  let diagnosticSource: RawAtomicQuoteSource | null = null;
  for (const entry of envelope.accepts ?? []) {
    if (entry.network !== expectedNetwork) continue;
    if (!isUsdc(entry, expectedNetwork)) continue;
    const rawSource = rawAtomicQuoteSource(entry);
    diagnosticSource ??= rawSource;
    const atomic = parseAtomic(rawSource?.value);
    if (atomic === null) continue;
    const amount = BigInt(atomic);
    if (!best || amount < best.amount) best = { entry, atomic, amount, rawSource: rawSource! };
  }
  return {
    selected: best
      ? { entry: best.entry, atomic: best.atomic, rawSource: best.rawSource }
      : null,
    diagnosticSource: best?.rawSource ?? diagnosticSource,
  };
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
  return selectCheapestUsdcAccept(envelope, expectedNetwork).selected?.atomic ?? null;
}

/**
 * Extract the full bound quote from one 402 response. When request binding is
 * supplied, the quote carries the validated seller requirements observation from
 * the same response. Seller nonce/expiresAt are deliberately not inferred.
 */
export function extractBoundQuote(
  response: { readonly headers: Record<string, string>; readonly body: unknown },
  options: {
    readonly expectedNetwork?: string;
    readonly requestBindingSha256?: string;
    readonly requirementsObservedAt?: Date | string;
  } = {},
): BoundQuote {
  const expectedNetwork = options.expectedNetwork ?? MAINNET_NETWORK;
  const envelope = envelopeFromHeaders(response.headers) ?? envelopeFromBody(response.body);
  if (!envelope?.accepts?.length) return EMPTY_BOUND_QUOTE;
  const selection = selectCheapestUsdcAccept(envelope, expectedNetwork);
  const rawSource = selection.diagnosticSource;
  const best = selection.selected;
  if (!best) {
    return {
      ...EMPTY_BOUND_QUOTE,
      rawSourceField: rawSource?.field ?? null,
      rawSourceValue: displayRawSourceValue(rawSource),
    };
  }
  const expectedAsset =
    expectedNetwork === TESTNET_NETWORK ? TESTNET_USDC_ADDRESS : MAINNET_USDC_ADDRESS;
  const parsedRequirements = options.requestBindingSha256
    ? parseAndBindSellerPaymentRequirements({
        headers: response.headers,
        body: response.body,
        requestBindingSha256: options.requestBindingSha256,
        expectedNetwork,
        expectedAsset,
        expectedScheme: "exact",
        requirementsObservedAt: options.requirementsObservedAt,
      })
    : null;
  return {
    atomic: best.atomic,
    sellerRequirements: parsedRequirements?.ok ? parsedRequirements.observation : null,
    sellerRequirementsError:
      parsedRequirements && !parsedRequirements.ok ? parsedRequirements.reason : null,
    nonce: null,
    expiresAt: null,
    rawSourceField: best.rawSource.field,
    rawSourceValue: displayRawSourceValue(best.rawSource),
  };
}

function quoteExtractionFailureReason(first: string | null, second: string | null): string | null {
  const failures: string[] = [];
  if (first === null) failures.push("first=missing");
  else if (!/^\d+$/.test(first)) failures.push("first=invalid_unsigned_integer");
  if (second === null) failures.push("second=missing");
  else if (!/^\d+$/.test(second)) failures.push("second=invalid_unsigned_integer");
  if (failures.length === 0) return null;
  return `${REJECTED_QUOTE_EXTRACTION_FAILED}: first=${first ?? "null"} second=${second ?? "null"}; ${failures.join(", ")}`;
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
  const extractionFailure = quoteExtractionFailureReason(first, second);
  if (extractionFailure) {
    return {
      stable: false,
      reason: extractionFailure,
      evidence,
      bound: EMPTY_BOUND_QUOTE,
      httpStatus: null,
      walletUsed: false,
      paymentAttempted: false,
    };
  }

  if (first !== second) {
    return {
      stable: false,
      reason: `${REJECTED_QUOTE_UNSTABLE}: first=${first} second=${second}`,
      evidence,
      bound: EMPTY_BOUND_QUOTE,
      httpStatus: null,
      walletUsed: false,
      paymentAttempted: false,
    };
  }

  return {
    stable: true,
    reason: null,
    evidence,
    bound: EMPTY_BOUND_QUOTE,
    httpStatus: null,
    walletUsed: false,
    paymentAttempted: false,
  };
}

export async function fetchSettleMethod402MaxAmountRequiredAtomic(options: {
  readonly requestBinding: ThinSettlementRequestBinding;
  readonly expectedNetwork?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: Date;
}): Promise<{
  readonly httpStatus: number | null;
  readonly maxAmountRequiredAtomic: string | null;
  readonly bound: BoundQuote;
  readonly detail: string | null;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const plan = planThinSettleRequest({
    requestBinding: options.requestBinding,
  });
  if (!plan.supported) {
    return {
      httpStatus: null,
      maxAmountRequiredAtomic: null,
      bound: EMPTY_BOUND_QUOTE,
      detail: plan.reason,
    };
  }
  const deadline = startAbortDeadline(timeoutMs);
  const headers = new Headers({
    accept: "application/json",
  });
  if (plan.sendBody) headers.set("content-type", "application/json");
  if (containsX402PaymentHeader(headers)) {
    deadline.clear();
    throw new Error("quote stability probe unexpectedly contains a payment header");
  }

  try {
    const response = await fetchImpl(plan.endpoint, {
      method: plan.method,
      headers,
      body: plan.sendBody ? JSON.stringify(plan.body) : undefined,
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
        bound: EMPTY_BOUND_QUOTE,
        detail: `expected HTTP 402, got ${response.status}`,
      };
    }
    const bound = extractBoundQuote(
      { headers: headerMap, body },
      {
        expectedNetwork: options.expectedNetwork,
        requestBindingSha256: options.requestBinding.binding_sha256,
        requirementsObservedAt: options.now ?? new Date(),
      },
    );
    return {
      httpStatus: response.status,
      maxAmountRequiredAtomic: bound.atomic,
      bound,
      detail: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      httpStatus: null,
      maxAmountRequiredAtomic: null,
      bound: EMPTY_BOUND_QUOTE,
      detail: message,
    };
  } finally {
    deadline.clear();
  }
}

export async function probeQuoteStability(options: {
  readonly requestBinding: ThinSettlementRequestBinding;
  readonly firstMaxAmountRequiredAtomic: string | null;
  readonly expectedNetwork?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: Date;
}): Promise<QuoteStabilityResult> {
  const second = await fetchSettleMethod402MaxAmountRequiredAtomic({
    requestBinding: options.requestBinding,
    expectedNetwork: options.expectedNetwork,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
    now: options.now,
  });
  const evaluated = evaluateQuoteStability(
    options.firstMaxAmountRequiredAtomic,
    second.maxAmountRequiredAtomic,
  );
  if (!evaluated.stable) {
    const reason =
      evaluated.reason?.includes(REJECTED_QUOTE_EXTRACTION_FAILED) && second.detail
        ? `${evaluated.reason}; second_detail=${second.detail}`
        : evaluated.reason;
    return {
      ...evaluated,
      bound: second.bound,
      httpStatus: second.httpStatus,
      reason,
    };
  }
  return {
    ...evaluated,
    bound: second.bound,
    httpStatus: second.httpStatus,
  };
}
