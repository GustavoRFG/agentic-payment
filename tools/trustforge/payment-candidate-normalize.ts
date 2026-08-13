/**
 * payment-candidate-normalize — raw / selected → PaymentCandidateV1.
 */

import {
  B5_PAYMENT_CANDIDATE_SCHEMA,
  GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT,
} from "./b5-execution-gates";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import {
  atomicToUsdcDisplay,
  bodyDigestFromValue,
  buildPaymentCandidateIdentityTuple,
  observationIdFromParts,
  paymentCandidateIdentitySha256,
  type PaymentCandidateV1,
} from "./payment-candidate-v1";

export interface RawPaymentCandidateObservation {
  readonly discovery_source: string;
  readonly discovered_at: string;
  readonly provider_id: string;
  readonly service_id: string;
  readonly service_label?: string;
  readonly endpoint: string;
  readonly method: "GET" | "POST" | "unknown";
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly body: unknown;
  readonly protocol?: "x402" | "unknown";
  readonly protocol_version?: number | "unknown";
  readonly scheme?: string | "unknown";
  readonly network_raw?: string | "unknown";
  readonly network_canonical?: string | "unknown";
  readonly chain_id?: number | "unknown";
  readonly asset?: string | "unknown";
  readonly amount_atomic?: string | "unknown";
  readonly pay_to?: string | "unknown";
  readonly request_binding_identity?: string | "unknown";
  readonly seller_requirements_identity?: string | "unknown";
  readonly max_timeout_seconds?: number | "unknown";
  readonly purpose?: string | "unknown";
  readonly notes?: readonly string[];
  readonly execution_selected_candidate?: DiscoveredSelectedCandidate | null;
}

function u<T>(value: T | undefined | null): T | "unknown" {
  if (value === undefined || value === null) return "unknown";
  return value;
}

export function normalizeRawPaymentCandidateObservation(
  raw: RawPaymentCandidateObservation,
): PaymentCandidateV1 {
  void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
  const method = raw.method === "GET" || raw.method === "POST" ? raw.method : "unknown";
  const body_digest = bodyDigestFromValue(raw.body ?? null);
  const identity = buildPaymentCandidateIdentityTuple({
    provider_id: raw.provider_id,
    service_id: raw.service_id,
    endpoint: raw.endpoint,
    method: method === "unknown" ? "UNKNOWN" : method,
    query: raw.query,
    body_digest,
    network_canonical:
      typeof raw.network_canonical === "string" ? raw.network_canonical : "unknown",
    asset: typeof raw.asset === "string" ? raw.asset : "unknown",
    pay_to: typeof raw.pay_to === "string" ? raw.pay_to : "unknown",
    amount_atomic:
      typeof raw.amount_atomic === "string" ? raw.amount_atomic : "unknown",
    protocol: raw.protocol ?? "x402",
    protocol_version:
      typeof raw.protocol_version === "number" ? String(raw.protocol_version) : "unknown",
    scheme: typeof raw.scheme === "string" ? raw.scheme : "unknown",
  });
  const candidate_id = paymentCandidateIdentitySha256(identity);
  const observation_id = observationIdFromParts(
    candidate_id,
    raw.discovered_at,
    raw.discovery_source,
  );
  const amount_atomic = u(raw.amount_atomic);
  const asset = u(raw.asset);
  return {
    schema_version: B5_PAYMENT_CANDIDATE_SCHEMA,
    candidate_id,
    observation_id,
    discovered_at: raw.discovered_at,
    discovery_source: raw.discovery_source,
    provider_id: raw.provider_id,
    service_id: raw.service_id,
    service_label: raw.service_label ?? raw.service_id,
    endpoint: raw.endpoint,
    method,
    query: raw.query.map(([k, v]) => [k, v] as const),
    body_digest,
    protocol: raw.protocol ?? "x402",
    protocol_version: u(raw.protocol_version),
    scheme: u(raw.scheme),
    network_raw: u(raw.network_raw),
    network_canonical: u(raw.network_canonical),
    chain_id: u(raw.chain_id),
    asset,
    asset_symbol: asset === "unknown" ? "unknown" : "USDC",
    asset_decimals: asset === "unknown" ? "unknown" : 6,
    amount_atomic,
    amount_display:
      typeof amount_atomic === "string" && amount_atomic !== "unknown"
        ? atomicToUsdcDisplay(amount_atomic)
        : "unknown",
    pay_to: u(raw.pay_to),
    request_binding_identity: u(raw.request_binding_identity),
    seller_requirements_identity: u(raw.seller_requirements_identity),
    max_timeout_seconds: u(raw.max_timeout_seconds),
    provenance: {
      discovery_adapter: raw.discovery_source,
      notes: raw.notes ?? [],
    },
    freshness: {
      observed_at: raw.discovered_at,
      max_timeout_seconds: u(raw.max_timeout_seconds),
    },
    expected_utility: {
      purpose: u(raw.purpose),
      utility_confidence: raw.purpose && raw.purpose !== "unknown" ? "low" : "none",
      evidence: "unknown",
    },
    cost: {
      amount_atomic,
      asset,
    },
    status: "NORMALIZED",
    execution_selected_candidate: raw.execution_selected_candidate ?? null,
  };
}

export function normalizeFromDiscoveredSelectedCandidate(
  selected: DiscoveredSelectedCandidate,
  options?: {
    readonly discovery_source?: string;
    readonly discovered_at?: string;
    readonly purpose?: string;
  },
): PaymentCandidateV1 {
  const discovered_at =
    options?.discovered_at ??
    selected.selection_requirements_observed_at ??
    selected.selected_at_utc;
  return normalizeRawPaymentCandidateObservation({
    discovery_source: options?.discovery_source ?? "discovered_selected_candidate",
    discovered_at,
    provider_id: selected.provider,
    service_id: selected.service_id,
    service_label: selected.service_id,
    endpoint: selected.endpoint,
    method: (selected.method ?? "GET") as "GET" | "POST",
    query: selected.request_query.map(([k, v]) => [k, v] as const),
    body: selected.request_body,
    protocol: "x402",
    protocol_version: selected.protocol_version,
    scheme: selected.scheme,
    network_raw: selected.seller_network_raw,
    network_canonical: selected.canonical_network_caip2,
    chain_id:
      selected.canonical_network_caip2 === "eip155:8453" ? 8453 : "unknown",
    asset: selected.asset,
    amount_atomic: selected.quote_atomic,
    pay_to: selected.authorized_pay_to,
    request_binding_identity: selected.request_binding_sha256,
    seller_requirements_identity: selected.canonical_requirements_sha256,
    max_timeout_seconds: selected.max_timeout_seconds,
    purpose: options?.purpose ?? "unknown",
    notes: ["normalized_from_trustforge_selected_candidate.v3"],
    execution_selected_candidate: selected,
  });
}
