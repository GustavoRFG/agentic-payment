/**
 * target-liveness - free x402 402 handshake probe for Bazaar-selected targets.
 */

import { createHash } from "node:crypto";
import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS, TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { atomicUsdcToDecimal } from "./external-x402-get-policy";
import type { TargetAccept, TargetCandidate } from "./target-candidates";

export type TargetHandshakeStatus =
  | "live_402_ok"
  | "wrong_asset"
  | "over_budget"
  | "no_402"
  | "malformed"
  | "timeout";

export interface RecordedProbeResponse {
  readonly httpStatus: number | null;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly bodyText?: string;
}

export interface TargetProbeRawResponse {
  readonly httpStatus: number | null;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly bodySha256: string | null;
}

export interface TargetHandshakeOutcome {
  readonly candidateId: string;
  readonly resourceUrl: string;
  readonly status: TargetHandshakeStatus;
  readonly httpStatus: number | null;
  readonly selectedAccept: TargetAccept | null;
  readonly challenge: {
    readonly nonce: string | null;
    readonly expiresAt: string | null;
  };
  readonly quoteAtomic: string | null;
  readonly quoteUsdc: string | null;
  readonly rawResponse: TargetProbeRawResponse;
  readonly detail: string | null;
  readonly walletUsed: false;
  readonly paymentAttempted: false;
  readonly paymentBearingHttpRequestCount: 0;
}

export interface ProbeTargetOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxTargetPriceAtomic: string;
}

interface AcceptEntry {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string;
  payTo?: string;
  maxTimeoutSeconds?: number | string;
  extra?: Record<string, unknown>;
}

interface PaymentEnvelope {
  accepts?: AcceptEntry[];
  x402Version?: number | string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function lowerHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      lower === "x-payment" ||
      lower === "payment-signature" ||
      lower === "authorization"
    ) {
      out[lower] = "[REDACTED]";
    } else {
      out[lower] = value;
    }
  });
  return out;
}

function bodyToText(body: unknown, bodyText?: string): string {
  if (bodyText !== undefined) return bodyText;
  if (typeof body === "string") return body;
  return JSON.stringify(body ?? null);
}

function parseJsonMaybe(text: string): unknown {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text.slice(0, 2000) };
  }
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
  if (direct && direct !== "[REDACTED]") return decodeJsonPossiblyBase64(direct);
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

function parseWwwAuthenticateChallenge(
  headers: Record<string, string>,
): { nonce: string | null; expiresAt: string | null } {
  const value = headers["www-authenticate"] ?? "";
  const nonce =
    value.match(/\bid="([^"]+)"/i)?.[1] ??
    value.match(/\bnonce="([^"]+)"/i)?.[1] ??
    null;
  const expiresAt =
    value.match(/\bexpires="([^"]+)"/i)?.[1] ??
    value.match(/\bexpiry="([^"]+)"/i)?.[1] ??
    null;
  return { nonce, expiresAt };
}

function nestedRecords(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown): void => {
    if (!isRecord(node) || seen.has(node)) return;
    seen.add(node);
    out.push(node);
    Object.values(node).forEach((child) => {
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    });
  };
  visit(value);
  return out;
}

function bodyChallenge(body: unknown): { nonce: string | null; expiresAt: string | null } {
  for (const record of nestedRecords(body)) {
    const nonce = record.nonce ?? record.id;
    const expires = record.expiresAt ?? record.expires ?? record.expiry ?? record.expiration;
    if (typeof nonce === "string" || typeof expires === "string") {
      return {
        nonce: typeof nonce === "string" ? nonce : null,
        expiresAt: typeof expires === "string" ? expires : null,
      };
    }
  }
  return { nonce: null, expiresAt: null };
}

function parseAtomic(value: string | undefined): bigint | null {
  if (!value || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
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
    (value) =>
      typeof value === "string" && value.toLowerCase() === expectedUsdc.toLowerCase(),
  );
}

function toTargetAccept(entry: AcceptEntry): TargetAccept {
  return {
    scheme: String(entry.scheme ?? ""),
    network: String(entry.network ?? ""),
    asset: String(entry.asset ?? ""),
    amountAtomic: String(entry.amount ?? entry.maxAmountRequired ?? ""),
    payTo: typeof entry.payTo === "string" ? entry.payTo : null,
    maxTimeoutSeconds:
      typeof entry.maxTimeoutSeconds === "number"
        ? entry.maxTimeoutSeconds
        : typeof entry.maxTimeoutSeconds === "string"
          ? Number.parseInt(entry.maxTimeoutSeconds, 10)
          : null,
  };
}

function cheapest(entries: readonly AcceptEntry[]): AcceptEntry | null {
  let best: { entry: AcceptEntry; amount: bigint } | null = null;
  for (const entry of entries) {
    const amount = parseAtomic(entry.amount ?? entry.maxAmountRequired);
    if (amount === null) continue;
    if (!best || amount < best.amount) best = { entry, amount };
  }
  return best?.entry ?? null;
}

function requestBodyFromCandidate(candidate: TargetCandidate): unknown {
  for (const record of nestedRecords(candidate.registrationMetadata)) {
    if (isRecord(record.input) && isRecord(record.input.body)) return record.input.body;
    if (isRecord(record.body)) return record.body;
  }
  return {};
}

export function classifyTargetProbeResponse(
  candidate: TargetCandidate,
  response: RecordedProbeResponse,
  options: { readonly maxTargetPriceAtomic: string; readonly expectedNetwork?: string },
): TargetHandshakeOutcome {
  const expectedNetwork = options.expectedNetwork ?? MAINNET_NETWORK;
  const text = bodyToText(response.body, response.bodyText);
  const body = typeof response.body === "string" ? parseJsonMaybe(response.body) : response.body;
  const rawResponse: TargetProbeRawResponse = {
    httpStatus: response.httpStatus,
    headers: response.headers,
    body,
    bodySha256: text ? sha256(text) : null,
  };
  const base = {
    candidateId: candidate.candidateId,
    resourceUrl: candidate.resourceUrl,
    httpStatus: response.httpStatus,
    rawResponse,
    walletUsed: false as const,
    paymentAttempted: false as const,
    paymentBearingHttpRequestCount: 0 as const,
  };

  if (response.httpStatus !== 402) {
    return {
      ...base,
      status: "no_402",
      selectedAccept: null,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: null,
      quoteUsdc: null,
      detail: `expected HTTP 402, got ${response.httpStatus ?? "null"}`,
    };
  }

  const envelope = envelopeFromHeaders(response.headers) ?? envelopeFromBody(body);
  if (!envelope?.accepts?.length) {
    return {
      ...base,
      status: "malformed",
      selectedAccept: null,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: null,
      quoteUsdc: null,
      detail: "HTTP 402 did not expose parseable accepts[]",
    };
  }

  const baseEntries = envelope.accepts.filter((entry) => entry.network === expectedNetwork);
  if (baseEntries.length === 0) {
    return {
      ...base,
      status: "malformed",
      selectedAccept: null,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: null,
      quoteUsdc: null,
      detail: `HTTP 402 accepts[] did not include ${expectedNetwork}`,
    };
  }

  const usdcEntries = baseEntries.filter((entry) => isUsdc(entry, expectedNetwork));
  if (usdcEntries.length === 0) {
    const expectedUsdc =
      expectedNetwork === TESTNET_NETWORK ? TESTNET_USDC_ADDRESS : MAINNET_USDC_ADDRESS;
    return {
      ...base,
      status: "wrong_asset",
      selectedAccept: null,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: null,
      quoteUsdc: null,
      detail: `HTTP 402 accepts[] did not include Base USDC ${expectedUsdc}`,
    };
  }

  const selected = cheapest(usdcEntries);
  if (!selected) {
    return {
      ...base,
      status: "malformed",
      selectedAccept: null,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: null,
      quoteUsdc: null,
      detail: "HTTP 402 Base USDC accepts[] did not include parseable amount",
    };
  }

  const selectedAccept = toTargetAccept(selected);
  if (selectedAccept.scheme !== "exact") {
    return {
      ...base,
      status: "malformed",
      selectedAccept,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: selectedAccept.amountAtomic,
      quoteUsdc: null,
      detail: `unsupported x402 scheme ${selectedAccept.scheme}`,
    };
  }
  if (!selectedAccept.payTo) {
    return {
      ...base,
      status: "malformed",
      selectedAccept,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: selectedAccept.amountAtomic,
      quoteUsdc: null,
      detail: "HTTP 402 selected accept is missing payTo",
    };
  }

  const amount = parseAtomic(selectedAccept.amountAtomic);
  const max = parseAtomic(options.maxTargetPriceAtomic);
  if (amount === null || max === null) {
    return {
      ...base,
      status: "malformed",
      selectedAccept,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: selectedAccept.amountAtomic,
      quoteUsdc: null,
      detail: "HTTP 402 selected accept has malformed amount or budget",
    };
  }
  if (amount > max) {
    return {
      ...base,
      status: "over_budget",
      selectedAccept,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: selectedAccept.amountAtomic,
      quoteUsdc: atomicUsdcToDecimal(selectedAccept.amountAtomic),
      detail: `HTTP 402 quote ${selectedAccept.amountAtomic} exceeds budget ${max.toString()}`,
    };
  }

  const headerChallenge = parseWwwAuthenticateChallenge(response.headers);
  const fallbackChallenge = bodyChallenge(body);
  let challenge = {
    nonce: headerChallenge.nonce ?? fallbackChallenge.nonce,
    expiresAt: headerChallenge.expiresAt ?? fallbackChallenge.expiresAt,
  };
  if (
    (!challenge.nonce || !challenge.expiresAt) &&
    expectedNetwork === TESTNET_NETWORK &&
    selectedAccept.maxTimeoutSeconds
  ) {
    const timeoutSec = selectedAccept.maxTimeoutSeconds;
    challenge = {
      nonce:
        challenge.nonce ??
        sha256(
          `${candidate.resourceUrl}:${selectedAccept.payTo}:${selectedAccept.amountAtomic}`,
        ).slice(0, 32),
      expiresAt:
        challenge.expiresAt ??
        new Date(Date.now() + timeoutSec * 1000).toISOString(),
    };
  }
  if (!challenge.nonce || !challenge.expiresAt) {
    return {
      ...base,
      status: "malformed",
      selectedAccept,
      challenge,
      quoteAtomic: selectedAccept.amountAtomic,
      quoteUsdc: atomicUsdcToDecimal(selectedAccept.amountAtomic),
      detail: "HTTP 402 challenge is missing nonce/id or expiry",
    };
  }

  return {
    ...base,
    status: "live_402_ok",
    selectedAccept,
    challenge,
    quoteAtomic: selectedAccept.amountAtomic,
    quoteUsdc: atomicUsdcToDecimal(selectedAccept.amountAtomic),
    detail: null,
  };
}

export async function probeTargetLiveness(
  candidate: TargetCandidate,
  options: ProbeTargetOptions,
): Promise<TargetHandshakeOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = new Headers({ accept: "application/json" });
  const bodyAllowed = ["POST", "PUT", "PATCH"].includes(candidate.method);
  const body = bodyAllowed ? JSON.stringify(requestBodyFromCandidate(candidate)) : undefined;
  if (bodyAllowed) headers.set("content-type", "application/json");
  if (containsX402PaymentHeader(headers)) {
    throw new Error("target liveness probe unexpectedly contains a payment header");
  }

  try {
    const response = await fetchImpl(candidate.resourceUrl, {
      method: candidate.method,
      headers,
      body,
      redirect: "manual",
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const recorded: RecordedProbeResponse = {
      httpStatus: response.status,
      headers: lowerHeaders(response.headers),
      body: parseJsonMaybe(bodyText),
      bodyText,
    };
    return classifyTargetProbeResponse(candidate, recorded, {
      maxTargetPriceAtomic: options.maxTargetPriceAtomic,
      expectedNetwork: candidate.accepts[0]?.network ?? MAINNET_NETWORK,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      candidateId: candidate.candidateId,
      resourceUrl: candidate.resourceUrl,
      status: message.toLowerCase().includes("abort") ? "timeout" : "malformed",
      httpStatus: null,
      selectedAccept: null,
      challenge: { nonce: null, expiresAt: null },
      quoteAtomic: null,
      quoteUsdc: null,
      rawResponse: {
        httpStatus: null,
        headers: {},
        body: null,
        bodySha256: null,
      },
      detail: message,
      walletUsed: false,
      paymentAttempted: false,
      paymentBearingHttpRequestCount: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTargetLivenessMany(
  candidates: readonly TargetCandidate[],
  options: ProbeTargetOptions,
): Promise<readonly TargetHandshakeOutcome[]> {
  const out: TargetHandshakeOutcome[] = [];
  for (const candidate of candidates) {
    out.push(await probeTargetLiveness(candidate, options));
  }
  return out;
}
