import { describe, expect, it } from "vitest";

import {
  adaptDiscoveredPrimaryToSelectedCandidate,
  recommendedAuthorizationMaxUsdc,
} from "../../tools/trustforge/discovered-target-to-selected-candidate";
import { ZAPPER_TX_EXPLAINER_POLICY } from "../../tools/trustforge/rich-tx-explainer-policy";

const endpoint = ZAPPER_TX_EXPLAINER_POLICY.endpointUrl;

describe("discovered target adapter", () => {
  it("maps a live_402_ok primary to selected_candidate with audit metadata", () => {
    const result = adaptDiscoveredPrimaryToSelectedCandidate(
      {
        selection: {
          primary: {
            handshakeStatus: "live_402_ok",
            resourceUrl: endpoint,
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
            scoringRationale: ["price_atomic=1125"],
          },
          fallbacks: [{ resourceUrl: "https://fallback.example/x402" }],
        },
      },
      new Date("2026-06-20T00:00:00.000Z"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate).toMatchObject({
      provider: "Zapper",
      service_id: "zapper_tx_explainer",
      endpoint,
      network: "eip155:8453",
      quote_amount_usdc: "0.001125",
      quote_atomic: "1125",
      authorized_pay_to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
      target_selection_audit: {
        selected_resource_url: endpoint,
        handshake_status: "live_402_ok",
        fallback_resource_urls: ["https://fallback.example/x402"],
        scoring_rationale: ["price_atomic=1125"],
      },
    });
  });

  it("rejects absent or non-live primaries without emitting a candidate", () => {
    expect(
      adaptDiscoveredPrimaryToSelectedCandidate({
        selection: { primary: null, fallbacks: [] },
      }).ok,
    ).toBe(false);
    expect(
      adaptDiscoveredPrimaryToSelectedCandidate({
        selection: {
          primary: {
            handshakeStatus: "malformed",
            resourceUrl: endpoint,
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
            scoringRationale: [],
          },
          fallbacks: [],
        },
      }).ok,
    ).toBe(false);
  });

  it("caps recommended max usdc at the centavo-scale ceiling", () => {
    expect(recommendedAuthorizationMaxUsdc("0.001125")).toBe("0.002125");
    expect(recommendedAuthorizationMaxUsdc("0.009")).toBe("0.01");
  });
});
