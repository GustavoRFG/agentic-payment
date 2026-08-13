/**
 * Synthetic PaymentCandidate / DiscoveredSelectedCandidate builders for B.5 tests.
 * NO REAL PAYMENT.
 */

import type { DiscoveredSelectedCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";
import type { RawPaymentCandidateObservation } from "../../tools/trustforge/payment-candidate-normalize";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import { canonicalJsonSha256 } from "../../tools/trustforge/x402-seller-requirements-binding";
import { SYNTHETIC_B33_RUNTIME_ADDRESS } from "./trustforge-synthetic-runtime-key";

const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";
const PAY_TO_B = "0x1111111111111111111111111111111111111111";

export function syntheticObservation(input: {
  readonly endpoint: string;
  readonly service_id: string;
  readonly provider_id?: string;
  readonly amount_atomic: string;
  readonly pay_to?: string;
  readonly network_canonical?: string;
  readonly scheme?: string;
  readonly protocol_version?: number;
  readonly method?: "GET" | "POST";
  readonly query?: ReadonlyArray<readonly [string, string]>;
  readonly discovered_at?: string;
  readonly purpose?: string;
  readonly with_execution_handoff?: boolean;
}): {
  readonly raw: RawPaymentCandidateObservation;
  readonly selected: DiscoveredSelectedCandidate | null;
  readonly fresh: SellerRequirementsObservation | null;
} {
  const method = input.method ?? "GET";
  const query = input.query ?? [["network", "ethereum"]];
  const pay_to = input.pay_to ?? PAY_TO;
  const network = input.network_canonical ?? "eip155:8453";
  const discovered_at = input.discovered_at ?? "2026-08-13T04:00:00.000Z";
  const scheme = input.scheme ?? "exact";
  const protocol_version = (input.protocol_version ?? 2) as 1 | 2;
  const binding = createThinSettlementRequestBinding({
    endpoint: input.endpoint,
    method,
    input_status: "known",
    query: query.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  });
  const selectedReq = {
    scheme,
    network,
    asset: ASSET,
    amount: input.amount_atomic,
    payTo: pay_to,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
  const envelope = {
    x402Version: protocol_version,
    accepts: [selectedReq],
    resource: { url: input.endpoint },
  };
  const reqHash = canonicalJsonSha256(selectedReq);
  const envHash = canonicalJsonSha256(envelope);
  const fresh: SellerRequirementsObservation = {
    requirements_observed_at: discovered_at,
    selected_requirements: selectedReq,
    payment_required_envelope: envelope,
    ancillary_tempo_evidence: null,
    binding: {
      protocol_version,
      transport: "payment-required-header",
      scheme,
      seller_network_raw: network,
      canonical_network_caip2: network as SellerRequirementsObservation["binding"]["canonical_network_caip2"],
      asset: ASSET,
      amount_field: "amount",
      amount_atomic: input.amount_atomic,
      pay_to,
      max_timeout_seconds: 300,
      resource: envelope.resource,
      extra: selectedReq.extra,
      request_binding_sha256: binding.binding_sha256,
      canonical_requirements_sha256: reqHash,
      canonical_envelope_sha256: envHash,
    },
  };

  const selected: DiscoveredSelectedCandidate = {
    schema_version: "trustforge_selected_candidate.v3",
    provider: input.provider_id ?? "synthetic_x402",
    service_id: input.service_id,
    endpoint: input.endpoint,
    method,
    request_input_status: "known",
    request_query: query.map(([k, v]) => [k, v] as [string, string]),
    request_body: null,
    request_input_provenance: binding.input_provenance,
    request_binding_sha256: binding.binding_sha256,
    protocol_version,
    transport: "payment-required-header",
    scheme,
    amount_field: "amount",
    max_timeout_seconds: 300,
    resource: envelope.resource,
    extra: selectedReq.extra,
    canonical_requirements_sha256: reqHash,
    canonical_envelope_sha256: envHash,
    selection_requirements_observed_at: discovered_at,
    ancillary_tempo_evidence: null,
    seller_requirements: fresh,
    quote_amount_usdc: (Number(input.amount_atomic) / 1_000_000).toString(),
    quote_atomic: input.amount_atomic,
    authorized_pay_to: pay_to,
    recommended_max_usdc: "0.005",
    seller_network_raw: network,
    canonical_network_caip2: network,
    network,
    asset: ASSET,
    buyer_wallet: SYNTHETIC_B33_RUNTIME_ADDRESS,
    target_selection_audit: {
      schema_version: "trustforge_target_selection_audit.v1",
      selected_at_utc: discovered_at,
    } as never,
    selected_at_utc: discovered_at,
  } as DiscoveredSelectedCandidate;

  const raw: RawPaymentCandidateObservation = {
    discovery_source: "static-test-fixtures",
    discovered_at,
    provider_id: input.provider_id ?? "synthetic_x402",
    service_id: input.service_id,
    service_label: input.service_id,
    endpoint: input.endpoint,
    method,
    query,
    body: null,
    protocol: "x402",
    protocol_version,
    scheme,
    network_raw: network,
    network_canonical: network,
    chain_id: network === "eip155:8453" ? 8453 : "unknown",
    asset: ASSET,
    amount_atomic: input.amount_atomic,
    pay_to,
    request_binding_identity: binding.binding_sha256,
    seller_requirements_identity: reqHash,
    max_timeout_seconds: 300,
    purpose: input.purpose ?? "synthetic_test",
    notes: ["synthetic"],
    execution_selected_candidate:
      input.with_execution_handoff === false ? null : selected,
  };

  return {
    raw,
    selected: input.with_execution_handoff === false ? null : selected,
    fresh: input.with_execution_handoff === false ? null : fresh,
  };
}

export const SYNTHETIC_ONESOURCE_ENDPOINT =
  "https://api.onesource.io/api/chain/block-number";
export const SYNTHETIC_ALT_ENDPOINT =
  "https://seller-b.example.invalid/api/v1/tip";
export const SYNTHETIC_PAY_TO_B = PAY_TO_B;
