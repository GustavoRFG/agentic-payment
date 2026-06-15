import { describe, expect, it } from "vitest";
import {
  candidateFromZapperDiscovery,
  candidateFromRegistryService,
  finalizeCandidates,
  selectBestCandidate,
  buildHumanAuthorizationTemplate,
} from "../../tools/trustforge/rich-provider-discovery";
import type { DiscoveryReport } from "../../tools/trustforge/rich-tx-explainer-discovery";
import { ZAPPER_TX_EXPLAINER_POLICY } from "../../tools/trustforge/rich-tx-explainer-policy";

const mockDiscovery: DiscoveryReport = {
  discovery_status: "FOUND_EQUIVALENT",
  oatp_found: false,
  candidates: [],
  selected_policy_id: ZAPPER_TX_EXPLAINER_POLICY.policyId,
  selected_policy: ZAPPER_TX_EXPLAINER_POLICY,
  gaps: [],
  sources_searched: [],
};

const mockHandshake = {
  policyId: ZAPPER_TX_EXPLAINER_POLICY.policyId,
  serviceId: "zapper_tx_explainer",
  endpointUrl: ZAPPER_TX_EXPLAINER_POLICY.endpointUrl,
  method: "POST",
  httpStatus: 402,
  quoteUsdc: "0.001125",
  network: "eip155:8453",
  asset: "USDC",
  assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
  amountAtomic: "1125",
  requestBody: { hash: "0xabc", chainId: 8453 },
  responseBodySha256: "abc",
  responseHeadersSanitized: {},
  responseBodySanitized: {},
  observedAtUtc: "2026-06-15T00:00:00.000Z",
  walletUsed: false as const,
  paymentAttempted: false as const,
};

describe("Phase 5 rich provider discovery", () => {
  it("prefers tx_explainer candidates over bootstrap registry services", () => {
    const zapper = candidateFromZapperDiscovery({
      discovery: mockDiscovery,
      handshake: mockHandshake,
      unpaidLivenessStatus: "pass",
    });
    const registry = candidateFromRegistryService({
      service_id: "onesource_api_chain_id",
      provider: "OneSource",
      endpoint_url: "https://api.onesource.io/api/chain/chain-id?network=ethereum",
      category: "chain_metadata",
      last_observed_quote_usdc: "0.001",
      status: "proven_unpaid_handshake",
      ground_truth_determinism: "deterministic",
    });
    const ranked = finalizeCandidates([registry, zapper]);
    expect(ranked[0].service_id).toBe("zapper_tx_explainer");
  });

  it("selects Zapper when all criteria met", () => {
    const zapper = candidateFromZapperDiscovery({
      discovery: mockDiscovery,
      handshake: mockHandshake,
      unpaidLivenessStatus: "pass",
    });
    const selected = selectBestCandidate([zapper]);
    expect(selected).not.toBeNull();
    expect(selected?.service_id).toBe("zapper_tx_explainer");
    expect(selected?.provider).toBe("Zapper");
  });

  it("returns null when no candidate meets criteria", () => {
    const zapper = candidateFromZapperDiscovery({
      discovery: mockDiscovery,
      handshake: null,
      unpaidLivenessStatus: "fail",
    });
    expect(selectBestCandidate([zapper])).toBeNull();
  });

  it("builds human authorization template with PENDING decision", () => {
    const selected = selectBestCandidate([
      candidateFromZapperDiscovery({
        discovery: mockDiscovery,
        handshake: mockHandshake,
        unpaidLivenessStatus: "pass",
      }),
    ]);
    expect(selected).not.toBeNull();
    const template = buildHumanAuthorizationTemplate(selected!);
    expect(template.decision).toBe("PENDING");
    expect(template.max_payment_attempts).toBe(1);
    expect(template.allow_retry).toBe(false);
    expect(template.require_settlement_evidence).toBe(true);
    expect(template.provider).toBe("Zapper");
  });
});
