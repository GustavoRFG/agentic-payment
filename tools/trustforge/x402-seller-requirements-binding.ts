/**
 * Pure x402 seller PaymentRequirements parsing, canonical binding, and freshness policy.
 *
 * Ownership boundary: this module handles unsigned seller requirements only. It has no
 * wallet, signer, authorization runner, executor, or fetch dependencies. Tempo's
 * WWW-Authenticate id/expires values are retained solely as non-authoritative evidence.
 */

import { createHash } from "node:crypto";
import {
  PaymentRequiredV1Schema,
  PaymentRequiredV2Schema,
  PaymentRequirementsV1Schema,
  PaymentRequirementsV2Schema,
} from "@x402/core/schemas";
import {
  normalizeX402NetworkIdentity,
  type X402NetworkIdentity,
} from "./x402-network-identity";

export const REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE =
  "REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE";
export const REJECTED_PAYMENT_REQUIREMENTS_VERSION_UNSUPPORTED =
  "REJECTED_PAYMENT_REQUIREMENTS_VERSION_UNSUPPORTED";
export const REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_MISSING =
  "REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_MISSING";
export const REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID =
  "REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID";
export const REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID =
  "REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID";
export const REJECTED_PAYMENT_REQUIREMENTS_REQUEST_BINDING_MISMATCH =
  "REJECTED_PAYMENT_REQUIREMENTS_REQUEST_BINDING_MISMATCH";
export const REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED =
  "REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED";
export const BLOCKED_PAYMENT_REQUIREMENTS_STALE = "BLOCKED_PAYMENT_REQUIREMENTS_STALE";
export const BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH =
  "BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH";
export const BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID =
  "BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID";

export const SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS = 300 as const;
export const HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS = 900 as const;
export const HUMAN_AUTHORIZATION_MAX_TTL_SECONDS = 1800 as const;
export const BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS = 60 as const;
export const TEMPO_ID_EXPIRES_POLICY = "RECORD_ONLY_NON_AUTHORITATIVE" as const;
export const SIGNED_BUT_NOT_SENT_POLICY = "TERMINAL_ABANDONED_REAUTHORIZE" as const;
export const SELLER_REQUIREMENTS_ENVELOPE_VALIDATION_POLICY =
  "STRICT_ENVELOPE_VALIDATION" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export type X402ProtocolVersion = 1 | 2;
export type SellerRequirementsTransport = "payment-required-header" | "legacy-body";
export type SellerAmountField = "amount" | "maxAmountRequired";
export type JsonObject = Readonly<Record<string, unknown>>;

export interface AncillaryTempoEvidence {
  readonly transport: "www-authenticate";
  readonly method: string | null;
  readonly id: string | null;
  readonly expires: string | null;
  readonly authoritative: false;
  readonly used_as_eip3009_nonce: false;
}

export interface SellerRequirementsBinding {
  readonly protocol_version: X402ProtocolVersion;
  readonly transport: SellerRequirementsTransport;
  readonly scheme: string;
  /** Exact, unmodified network identifier supplied by the seller. */
  readonly seller_network_raw: string;
  /** Version-aware operational identity; never substituted into seller JSON/hashes. */
  readonly canonical_network_caip2: X402NetworkIdentity["canonical_caip2"];
  readonly asset: string;
  readonly amount_field: SellerAmountField;
  readonly amount_atomic: string;
  readonly pay_to: string;
  readonly max_timeout_seconds: number;
  readonly resource: unknown;
  readonly extra: unknown;
  readonly request_binding_sha256: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
}

export interface SellerRequirementsObservation {
  readonly requirements_observed_at: string;
  readonly selected_requirements: JsonObject;
  readonly payment_required_envelope: JsonObject;
  readonly binding: SellerRequirementsBinding;
  readonly ancillary_tempo_evidence: AncillaryTempoEvidence | null;
}

export type SellerRequirementsFailureCategory =
  | "parse"
  | "network"
  | "asset"
  | "scheme"
  | "amount"
  | "timeout"
  | "hash"
  | "request-binding";

export type SellerRequirementsParseResult =
  | { readonly ok: true; readonly observation: SellerRequirementsObservation }
  | {
      readonly ok: false;
      readonly code: string;
      readonly reason: string;
      readonly category: SellerRequirementsFailureCategory;
      readonly ancillary_tempo_evidence: AncillaryTempoEvidence | null;
    };
type SellerRequirementsFailure = Extract<SellerRequirementsParseResult, { readonly ok: false }>;

interface ExtractedEnvelope {
  readonly transport: SellerRequirementsTransport;
  readonly envelope: JsonObject;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function canonicalize(value: unknown, seen: Set<unknown>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite number is not canonical JSON");
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") {
    throw new Error(`non-JSON value type ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("cyclic value is not canonical JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new Error("sparse array is not canonical JSON");
        }
      }
      return `[${value.map((entry) => canonicalize(entry, seen)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("non-plain object is not canonical JSON");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Object properties are sorted; array order and duplicate array entries are preserved. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

export function canonicalJsonSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function decodeJsonPossiblyBase64(value: string): JsonObject | null {
  const trimmed = value.trim();
  try {
    const decoded = trimmed.startsWith("{")
      ? trimmed
      : Buffer.from(
          trimmed.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(trimmed.length / 4) * 4, "="),
          "base64",
        ).toString("utf8");
    const parsed = JSON.parse(decoded) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function bodyEnvelope(body: unknown): JsonObject | null {
  if (!isRecord(body)) return null;
  if (Array.isArray(body.accepts)) return body;
  for (const key of ["paymentRequirements", "x402PaymentRequirements", "requirements"]) {
    const nested = body[key];
    if (isRecord(nested) && Array.isArray(nested.accepts)) return nested;
  }
  return null;
}

function extractEnvelope(headers: Record<string, string>, body: unknown): ExtractedEnvelope | null {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const headerValue = normalized["payment-required"] ?? normalized["x-payment-required"];
  if (headerValue && headerValue !== "[REDACTED]") {
    const envelope = decodeJsonPossiblyBase64(headerValue);
    return envelope ? { transport: "payment-required-header", envelope } : null;
  }
  const envelope = bodyEnvelope(body);
  return envelope ? { transport: "legacy-body", envelope } : null;
}

function quotedParameter(value: string, name: string): string | null {
  const quoted = value.match(new RegExp(`\\b${name}="([^"]+)"`, "i"))?.[1];
  if (quoted) return quoted;
  return value.match(new RegExp(`\\b${name}=([^,\\s]+)`, "i"))?.[1] ?? null;
}

export function parseAncillaryTempoEvidence(
  headers: Record<string, string>,
): AncillaryTempoEvidence | null {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === "www-authenticate");
  const value = entry?.[1] ?? "";
  if (!/\bPayment\b/i.test(value)) return null;
  const method = quotedParameter(value, "method");
  const id = quotedParameter(value, "id") ?? quotedParameter(value, "nonce");
  const expires =
    quotedParameter(value, "expires") ??
    quotedParameter(value, "expiry") ??
    quotedParameter(value, "expiration");
  if (!method && !id && !expires) return null;
  return {
    transport: "www-authenticate",
    method,
    id,
    expires,
    authoritative: false,
    used_as_eip3009_nonce: false,
  };
}

function failure(
  code: string,
  detail: string,
  category: SellerRequirementsFailureCategory,
  ancillary: AncillaryTempoEvidence | null,
): SellerRequirementsFailure {
  return { ok: false, code, reason: `${code}: ${detail}`, category, ancillary_tempo_evidence: ancillary };
}

function timeoutFailure(
  accepts: readonly unknown[],
  ancillary: AncillaryTempoEvidence | null,
): SellerRequirementsFailure | null {
  // STRICT_ENVELOPE_VALIDATION: every accept must be schema-valid before selection.
  // Aggregate first so reversing accepts[] cannot arbitrarily change the error code.
  const records = accepts.filter(isRecord);
  if (records.some((raw) => !Object.prototype.hasOwnProperty.call(raw, "maxTimeoutSeconds"))) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_MISSING,
      "maxTimeoutSeconds is required on every accepts[] entry",
      "timeout",
      ancillary,
    );
  }
  if (
    records.some((raw) => {
      const timeout = raw.maxTimeoutSeconds;
      return (
        typeof timeout !== "number" ||
        !Number.isFinite(timeout) ||
        !Number.isInteger(timeout) ||
        timeout <= 0
      );
    })
  ) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID,
      "maxTimeoutSeconds must be a positive finite integer on every accepts[] entry",
      "timeout",
      ancillary,
    );
  }
  return null;
}

function normalizedAssetMatches(value: unknown, expectedAsset: string): boolean {
  return typeof value === "string" && value.toLowerCase() === expectedAsset.toLowerCase();
}

function amountFor(version: X402ProtocolVersion, requirement: JsonObject): unknown {
  return version === 1 ? requirement.maxAmountRequired : requirement.amount;
}

function selectRequirement(input: {
  readonly version: X402ProtocolVersion;
  readonly accepts: readonly JsonObject[];
  readonly expectedNetwork: string;
  readonly expectedAsset: string;
  readonly expectedScheme: string;
  readonly ancillary: AncillaryTempoEvidence | null;
}):
  | SellerRequirementsFailure
  | {
      readonly ok: true;
      readonly requirement: JsonObject;
      readonly networkIdentity: X402NetworkIdentity;
    } {
  const normalized = input.accepts.flatMap((entry) => {
    try {
      return [
        {
          entry,
          identity: normalizeX402NetworkIdentity(input.version, entry.network),
        },
      ];
    } catch {
      return [];
    }
  });
  const network = normalized.filter(
    ({ identity }) => identity.canonical_caip2 === input.expectedNetwork,
  );
  if (network.length === 0) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      `no requirement for network ${input.expectedNetwork}`,
      "network",
      input.ancillary,
    );
  }
  const asset = network.filter(({ entry }) =>
    normalizedAssetMatches(entry.asset, input.expectedAsset),
  );
  if (asset.length === 0) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      `no requirement for asset ${input.expectedAsset}`,
      "asset",
      input.ancillary,
    );
  }
  const scheme = asset.filter(({ entry }) => entry.scheme === input.expectedScheme);
  if (scheme.length === 0) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      `no requirement for scheme ${input.expectedScheme}`,
      "scheme",
      input.ancillary,
    );
  }
  let best: {
    readonly requirement: JsonObject;
    readonly networkIdentity: X402NetworkIdentity;
    readonly amount: bigint;
  } | null = null;
  for (const { entry: requirement, identity } of scheme) {
    const rawAmount = amountFor(input.version, requirement);
    if (typeof rawAmount !== "string" || !/^\d+$/.test(rawAmount)) continue;
    const amount = BigInt(rawAmount);
    if (!best || amount < best.amount) {
      best = { requirement, networkIdentity: identity, amount };
    }
  }
  if (!best) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      "selected requirements amount must be an unsigned integer string",
      "amount",
      input.ancillary,
    );
  }
  return {
    ok: true,
    requirement: best.requirement,
    networkIdentity: best.networkIdentity,
  };
}

function observedAtIso(value: Date | string | undefined): string | null {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function parseAndBindSellerPaymentRequirements(input: {
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly requestBindingSha256: string;
  readonly expectedNetwork: string;
  readonly expectedAsset: string;
  readonly expectedScheme?: string;
  readonly requirementsObservedAt?: Date | string;
}): SellerRequirementsParseResult {
  const ancillary = parseAncillaryTempoEvidence(input.headers);
  const extracted = extractEnvelope(input.headers, input.body);
  if (!extracted) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      "PaymentRequired envelope is missing or undecodable",
      "parse",
      ancillary,
    );
  }
  const version = extracted.envelope.x402Version;
  if (version !== 1 && version !== 2) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_VERSION_UNSUPPORTED,
      `x402Version ${String(version)} is unsupported`,
      "parse",
      ancillary,
    );
  }
  const acceptsRaw = extracted.envelope.accepts;
  if (!Array.isArray(acceptsRaw) || acceptsRaw.length === 0) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      "accepts[] is required and must not be empty",
      "parse",
      ancillary,
    );
  }
  const timeoutProblem = timeoutFailure(acceptsRaw, ancillary);
  if (timeoutProblem) return timeoutProblem;
  try {
    canonicalJson(extracted.envelope);
  } catch (error) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID,
      error instanceof Error ? error.message : String(error),
      "hash",
      ancillary,
    );
  }
  const schemaResult =
    version === 1
      ? PaymentRequiredV1Schema.safeParse(extracted.envelope)
      : PaymentRequiredV2Schema.safeParse(extracted.envelope);
  if (!schemaResult.success) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      schemaResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      "parse",
      ancillary,
    );
  }
  const accepts = acceptsRaw.filter(isRecord);
  if (accepts.length !== acceptsRaw.length) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      "every accepts[] entry must be an object",
      "parse",
      ancillary,
    );
  }
  const selected = selectRequirement({
    version,
    accepts,
    expectedNetwork: input.expectedNetwork,
    expectedAsset: input.expectedAsset,
    expectedScheme: input.expectedScheme ?? "exact",
    ancillary,
  });
  if (!selected.ok) return selected;
  const requestBindingSha256 = input.requestBindingSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(requestBindingSha256)) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_REQUEST_BINDING_MISMATCH,
      "request binding must be a canonical SHA-256 digest",
      "request-binding",
      ancillary,
    );
  }
  const requirementsObservedAt = observedAtIso(input.requirementsObservedAt);
  if (!requirementsObservedAt) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE,
      "requirements_observed_at is invalid",
      "parse",
      ancillary,
    );
  }
  const requirement = selected.requirement;
  const amountField: SellerAmountField = version === 1 ? "maxAmountRequired" : "amount";
  const resource = version === 1 ? requirement.resource : extracted.envelope.resource;
  try {
    const binding: SellerRequirementsBinding = {
      protocol_version: version,
      transport: extracted.transport,
      scheme: String(requirement.scheme),
      seller_network_raw: selected.networkIdentity.seller_network_raw,
      canonical_network_caip2: selected.networkIdentity.canonical_caip2,
      asset: String(requirement.asset),
      amount_field: amountField,
      amount_atomic: String(requirement[amountField]),
      pay_to: String(requirement.payTo),
      max_timeout_seconds: requirement.maxTimeoutSeconds as number,
      resource: resource ?? null,
      extra: Object.prototype.hasOwnProperty.call(requirement, "extra") ? requirement.extra : null,
      request_binding_sha256: requestBindingSha256,
      canonical_requirements_sha256: canonicalJsonSha256(requirement),
      canonical_envelope_sha256: canonicalJsonSha256(extracted.envelope),
    };
    return {
      ok: true,
      observation: {
        requirements_observed_at: requirementsObservedAt,
        selected_requirements: requirement,
        payment_required_envelope: extracted.envelope,
        binding,
        ancillary_tempo_evidence: ancillary,
      },
    };
  } catch (error) {
    return failure(
      REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID,
      error instanceof Error ? error.message : String(error),
      "hash",
      ancillary,
    );
  }
}

export function validatePersistedSellerRequirementsObservation(
  observation: SellerRequirementsObservation | null | undefined,
  expectedRequestBindingSha256: string,
): { readonly valid: boolean; readonly reasons: readonly string[] } {
  if (!observation?.binding || !observation.selected_requirements || !observation.payment_required_envelope) {
    return {
      valid: false,
      reasons: [`${REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED}: seller requirements observation absent`],
    };
  }
  const reasons: string[] = [];
  const expectedRequest = expectedRequestBindingSha256.trim().toLowerCase();
  if (!SHA256_PATTERN.test(expectedRequest) || observation.binding.request_binding_sha256 !== expectedRequest) {
    reasons.push(
      `${REJECTED_PAYMENT_REQUIREMENTS_REQUEST_BINDING_MISMATCH}: requirements binding differs from request binding`,
    );
  }
  if (!Number.isFinite(Date.parse(observation.requirements_observed_at))) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE}: requirements_observed_at invalid`);
  }
  const version = observation.binding.protocol_version;
  if (version !== 1 && version !== 2) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_VERSION_UNSUPPORTED}: ${String(version)}`);
    return { valid: false, reasons };
  }
  const timeout = observation.binding.max_timeout_seconds;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID}: persisted timeout invalid`);
  }
  if (
    !SHA256_PATTERN.test(observation.binding.canonical_requirements_sha256) ||
    !SHA256_PATTERN.test(observation.binding.canonical_envelope_sha256)
  ) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID}: persisted hash format invalid`);
  }
  if (
    observation.binding.transport !== "payment-required-header" &&
    observation.binding.transport !== "legacy-body"
  ) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE}: persisted transport invalid`);
  }
  const requirementSchema = version === 1 ? PaymentRequirementsV1Schema : PaymentRequirementsV2Schema;
  if (!requirementSchema.safeParse(observation.selected_requirements).success) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE}: persisted selected requirements invalid`);
  }
  const envelopeSchema = version === 1 ? PaymentRequiredV1Schema : PaymentRequiredV2Schema;
  if (!envelopeSchema.safeParse(observation.payment_required_envelope).success) {
    reasons.push(`${REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE}: persisted PaymentRequired envelope invalid`);
  }
  try {
    const requirementsHash = canonicalJsonSha256(observation.selected_requirements);
    const envelopeHash = canonicalJsonSha256(observation.payment_required_envelope);
    if (requirementsHash !== observation.binding.canonical_requirements_sha256) {
      reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: requirements hash mismatch`);
    }
    if (envelopeHash !== observation.binding.canonical_envelope_sha256) {
      reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: envelope hash mismatch`);
    }
    const accepts = observation.payment_required_envelope.accepts;
    if (
      !Array.isArray(accepts) ||
      !accepts.some((entry) => {
        try {
          return canonicalJsonSha256(entry) === requirementsHash;
        } catch {
          return false;
        }
      })
    ) {
      reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: selected requirements absent from envelope`);
    }
  } catch (error) {
    reasons.push(
      `${REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = observation.selected_requirements;
  const amountField: SellerAmountField = version === 1 ? "maxAmountRequired" : "amount";
  const expectedResource = version === 1 ? raw.resource : observation.payment_required_envelope.resource;
  const expectedExtra = Object.prototype.hasOwnProperty.call(raw, "extra") ? raw.extra : null;
  let matches = false;
  try {
    const networkIdentity = normalizeX402NetworkIdentity(version, raw.network);
    matches =
      observation.binding.amount_field === amountField &&
      observation.binding.scheme === raw.scheme &&
      observation.binding.seller_network_raw === raw.network &&
      observation.binding.canonical_network_caip2 === networkIdentity.canonical_caip2 &&
      observation.binding.asset === raw.asset &&
      observation.binding.amount_atomic === raw[amountField] &&
      observation.binding.pay_to === raw.payTo &&
      observation.binding.max_timeout_seconds === raw.maxTimeoutSeconds &&
      canonicalJson(observation.binding.resource) === canonicalJson(expectedResource ?? null) &&
      canonicalJson(observation.binding.extra) === canonicalJson(expectedExtra);
  } catch (error) {
    reasons.push(
      `${REJECTED_PAYMENT_REQUIREMENTS_HASH_INVALID}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!matches) {
    reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: normalized binding differs from seller JSON`);
  }
  return { valid: reasons.length === 0, reasons };
}

export interface EffectiveSigningDeadlineResult {
  readonly effective_signing_deadline: string;
  readonly seller_timeout_deadline: string;
  readonly local_freshness_deadline: string;
  readonly human_authorization_expires_at: string;
  readonly stale: boolean;
}

function requiredTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: ${label} invalid`);
  }
  return parsed;
}

export function calculateEffectiveSigningDeadline(input: {
  readonly paytimeRequirementsObservedAt: string;
  readonly maxTimeoutSeconds: number;
  readonly humanAuthorizationExpiresAt: string;
  readonly now?: Date;
  readonly localFreshnessCapSeconds?: number;
}): EffectiveSigningDeadlineResult {
  const timeout = input.maxTimeoutSeconds;
  if (!Number.isFinite(timeout) || !Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`${REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID}: maxTimeoutSeconds invalid`);
  }
  const localCap = input.localFreshnessCapSeconds ?? SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS;
  if (!Number.isFinite(localCap) || !Number.isInteger(localCap) || localCap <= 0) {
    throw new Error(`${REJECTED_PAYMENT_REQUIREMENTS_TIMEOUT_INVALID}: local freshness cap invalid`);
  }
  const observedMs = requiredTimestamp(input.paytimeRequirementsObservedAt, "pay-time observation");
  const humanMs = requiredTimestamp(input.humanAuthorizationExpiresAt, "human authorization expiry");
  const sellerMs = observedMs + timeout * 1000;
  const localMs = observedMs + localCap * 1000;
  const effectiveMs = Math.min(sellerMs, localMs, humanMs);
  const nowMs = (input.now ?? new Date()).getTime();
  return {
    effective_signing_deadline: new Date(effectiveMs).toISOString(),
    seller_timeout_deadline: new Date(sellerMs).toISOString(),
    local_freshness_deadline: new Date(localMs).toISOString(),
    human_authorization_expires_at: new Date(humanMs).toISOString(),
    stale: nowMs >= effectiveMs,
  };
}

export function validateFutureBuyerValidBefore(
  validBefore: string | number | bigint,
  effectiveSigningDeadline: string,
): { readonly valid: boolean; readonly reason: string | null } {
  const deadlineSeconds = Math.floor(requiredTimestamp(effectiveSigningDeadline, "effective signing deadline") / 1000);
  let validBeforeSeconds: bigint;
  try {
    validBeforeSeconds = BigInt(validBefore);
  } catch {
    return {
      valid: false,
      reason: `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: validBefore is not an integer`,
    };
  }
  if (validBeforeSeconds > BigInt(deadlineSeconds)) {
    return {
      valid: false,
      reason: `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: validBefore exceeds effective signing deadline`,
    };
  }
  return { valid: true, reason: null };
}

export function authorizationExpiresAt(
  decidedAt: string | Date,
  ttlSeconds = HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS,
): string {
  if (!Number.isFinite(ttlSeconds) || !Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > HUMAN_AUTHORIZATION_MAX_TTL_SECONDS) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: authorization TTL must be 1..${HUMAN_AUTHORIZATION_MAX_TTL_SECONDS} seconds`,
    );
  }
  const date = decidedAt instanceof Date ? decidedAt : new Date(decidedAt);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: decided_at invalid`);
  }
  return new Date(date.getTime() + ttlSeconds * 1000).toISOString();
}
