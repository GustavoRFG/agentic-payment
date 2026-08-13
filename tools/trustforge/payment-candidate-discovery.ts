/**
 * payment-candidate-discovery — pluggable raw observations (no payment authority).
 */

import {
  GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT,
} from "./b5-execution-gates";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import {
  normalizeFromDiscoveredSelectedCandidate,
  normalizeRawPaymentCandidateObservation,
  type RawPaymentCandidateObservation,
} from "./payment-candidate-normalize";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";

export interface PaymentCandidateDiscovery {
  readonly adapter_id: string;
  discover(): Promise<readonly RawPaymentCandidateObservation[]>;
}

export function createStaticFixtureDiscovery(
  observations: readonly RawPaymentCandidateObservation[],
): PaymentCandidateDiscovery {
  return {
    adapter_id: "static-test-fixtures",
    async discover() {
      void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
      return observations.map((o) => ({
        ...o,
        discovery_source: o.discovery_source || "static-test-fixtures",
      }));
    },
  };
}

export function createDiscoveredSelectedCandidateDiscovery(
  selected: DiscoveredSelectedCandidate,
  options?: { readonly purpose?: string; readonly discovered_at?: string },
): PaymentCandidateDiscovery {
  return {
    adapter_id: "discovered_x402_selected_candidate",
    async discover() {
      void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
      const normalized = normalizeFromDiscoveredSelectedCandidate(selected, {
        discovery_source: "discovered_x402_selected_candidate",
        discovered_at: options?.discovered_at,
        purpose: options?.purpose,
      });
      return [
        {
          discovery_source: "discovered_x402_selected_candidate",
          discovered_at: normalized.discovered_at,
          provider_id: normalized.provider_id,
          service_id: normalized.service_id,
          service_label: normalized.service_label,
          endpoint: normalized.endpoint,
          method: normalized.method === "unknown" ? "GET" : normalized.method,
          query: normalized.query,
          body: selected.request_body,
          protocol: "x402",
          protocol_version:
            typeof normalized.protocol_version === "number"
              ? normalized.protocol_version
              : "unknown",
          scheme: normalized.scheme,
          network_raw: normalized.network_raw,
          network_canonical: normalized.network_canonical,
          chain_id: normalized.chain_id,
          asset: normalized.asset,
          amount_atomic: normalized.amount_atomic,
          pay_to: normalized.pay_to,
          request_binding_identity: normalized.request_binding_identity,
          seller_requirements_identity: normalized.seller_requirements_identity,
          max_timeout_seconds: normalized.max_timeout_seconds,
          purpose: options?.purpose ?? normalized.expected_utility.purpose,
          notes: normalized.provenance.notes,
          execution_selected_candidate: selected,
        },
      ];
    },
  };
}

export async function discoverAndNormalize(
  discovery: PaymentCandidateDiscovery,
): Promise<readonly PaymentCandidateV1[]> {
  void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
  const raw = await discovery.discover();
  return raw.map((r) => normalizeRawPaymentCandidateObservation(r));
}
