/**
 * payment-candidate-v1 — neutral PaymentCandidate contract (B.5).
 *
 * Vendor-agnostic planning evidence. Not payment authority.
 */

import { createHash } from "node:crypto";

import {
  B5_PAYMENT_CANDIDATE_SCHEMA,
  GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT,
} from "./b5-execution-gates";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import { canonicalJson, canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export type PaymentCandidateStatus =
  | "DISCOVERED"
  | "NORMALIZED"
  | "UNKNOWN";

export type UnknownOr<T> = T | "unknown";

export interface PaymentCandidateV1 {
  readonly schema_version: typeof B5_PAYMENT_CANDIDATE_SCHEMA;
  /** Deterministic economic/request identity (stable across re-observations). */
  readonly candidate_id: string;
  /** Unique observation instance. */
  readonly observation_id: string;
  readonly discovered_at: string;
  readonly discovery_source: string;
  readonly provider_id: string;
  readonly service_id: string;
  readonly service_label: string;
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "unknown";
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly body_digest: UnknownOr<string>;
  readonly protocol: "x402" | "unknown";
  readonly protocol_version: UnknownOr<number>;
  readonly scheme: UnknownOr<string>;
  readonly network_raw: UnknownOr<string>;
  readonly network_canonical: UnknownOr<string>;
  readonly chain_id: UnknownOr<number>;
  readonly asset: UnknownOr<string>;
  readonly asset_symbol: UnknownOr<string>;
  readonly asset_decimals: UnknownOr<number>;
  readonly amount_atomic: UnknownOr<string>;
  readonly amount_display: UnknownOr<string>;
  readonly pay_to: UnknownOr<string>;
  readonly request_binding_identity: UnknownOr<string>;
  readonly seller_requirements_identity: UnknownOr<string>;
  readonly max_timeout_seconds: UnknownOr<number>;
  readonly provenance: {
    readonly discovery_adapter: string;
    readonly notes: readonly string[];
  };
  readonly freshness: {
    readonly observed_at: string;
    readonly max_timeout_seconds: UnknownOr<number>;
  };
  readonly expected_utility: {
    readonly purpose: UnknownOr<string>;
    readonly utility_confidence: "none" | "low" | "medium" | "high";
    readonly evidence: UnknownOr<string>;
  };
  readonly cost: {
    readonly amount_atomic: UnknownOr<string>;
    readonly asset: UnknownOr<string>;
  };
  readonly status: PaymentCandidateStatus;
  /**
   * Optional B4 handoff payload. Present when normalized from a full
   * DiscoveredSelectedCandidate. Never grants payment authority by itself.
   */
  readonly execution_selected_candidate: DiscoveredSelectedCandidate | null;
}

/** Identity tuple used for candidate_id (excludes timestamps/observation). */
export interface PaymentCandidateIdentityTuple {
  readonly provider_id: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly method: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly body_digest: string;
  readonly network_canonical: string;
  readonly asset: string;
  readonly pay_to: string;
  readonly amount_atomic: string;
  readonly protocol: string;
  readonly protocol_version: string;
  readonly scheme: string;
}

export function buildPaymentCandidateIdentityTuple(
  input: Omit<PaymentCandidateIdentityTuple, never>,
): PaymentCandidateIdentityTuple {
  const query = [...input.query]
    .map(([k, v]) => [String(k), String(v)] as [string, string])
    .sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return {
    provider_id: input.provider_id.toLowerCase(),
    service_id: input.service_id,
    endpoint: input.endpoint,
    method: input.method.toUpperCase(),
    query,
    body_digest: input.body_digest,
    network_canonical: input.network_canonical.toLowerCase(),
    asset: input.asset.toLowerCase(),
    pay_to: input.pay_to.toLowerCase(),
    amount_atomic: input.amount_atomic,
    protocol: input.protocol,
    protocol_version: String(input.protocol_version),
    scheme: input.scheme,
  };
}

export function paymentCandidateIdentitySha256(
  tuple: PaymentCandidateIdentityTuple,
): string {
  void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
  return canonicalJsonSha256(tuple);
}

export function observationIdFromParts(
  candidateId: string,
  discoveredAt: string,
  discoverySource: string,
): string {
  return createHash("sha256")
    .update(`${candidateId}|${discoveredAt}|${discoverySource}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

export function assertPaymentCandidateIsNotAuthority(
  _candidate: PaymentCandidateV1,
): void {
  void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
  void _candidate;
}

export function paymentCandidateSha256(candidate: PaymentCandidateV1): string {
  const { execution_selected_candidate: _exec, ...rest } = candidate;
  return canonicalJsonSha256(rest);
}

export function atomicToUsdcDisplay(amountAtomic: string): string | "unknown" {
  if (!/^\d+$/.test(amountAtomic)) return "unknown";
  const n = BigInt(amountAtomic);
  const whole = n / 1_000_000n;
  const frac = n % 1_000_000n;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(6, "0").replace(/0+$/, "")}`;
}

export function bodyDigestFromValue(body: unknown): string {
  if (body === null || body === undefined) {
    return createHash("sha256").update("null", "utf8").digest("hex");
  }
  return createHash("sha256").update(canonicalJson(body), "utf8").digest("hex");
}
