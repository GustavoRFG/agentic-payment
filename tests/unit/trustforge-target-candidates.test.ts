import { describe, expect, it } from "vitest";

import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { BazaarResource } from "../../tools/trustforge/bazaar-client";
import {
  filterTargetCandidates,
  inferHttpMethod,
  normalizeTargetCandidate,
  resolveMaxTargetPriceAtomic,
} from "../../tools/trustforge/target-candidates";

const PAY_TO = "0x1111111111111111111111111111111111111111";

function resource(overrides: Partial<BazaarResource> = {}): BazaarResource {
  return {
    resourceUrl: "https://seller.example/x402",
    type: "http",
    x402Version: 2,
    lastUpdated: "2026-06-20T00:00:00.000Z",
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "POST", bodyType: "json", body: {} },
        },
      },
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: MAINNET_USDC_ADDRESS,
        amount: "1000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: "USDC" },
      },
    ],
    ...overrides,
  };
}

describe("TargetCandidate normalization and filtering", () => {
  it("uses the default centavo-scale budget and env override", () => {
    expect(resolveMaxTargetPriceAtomic({})).toBe("10000");
    expect(
      resolveMaxTargetPriceAtomic({ TRUSTFORGE_MAX_TARGET_PRICE_ATOMIC: "42" }),
    ).toBe("42");
  });

  it("infers HTTP method from nested Bazaar extension metadata", () => {
    expect(inferHttpMethod(resource().extensions)).toBe("POST");
    expect(inferHttpMethod({})).toBe("GET");
  });

  it("normalizes Bazaar resources into target candidates", () => {
    const candidate = normalizeTargetCandidate(resource());

    expect(candidate.resourceUrl).toBe("https://seller.example/x402");
    expect(candidate.method).toBe("POST");
    expect(candidate.accepts[0]).toEqual({
      scheme: "exact",
      network: "eip155:8453",
      asset: MAINNET_USDC_ADDRESS,
      amountAtomic: "1000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    });
    expect(candidate.freshness.sortKey).toBe("2026-06-20T00:00:00.000Z");
    expect(candidate.requestBinding?.body).toEqual({});
    expect(candidate.requestInputProvenance).toBe(
      "bazaar.extensions.bazaar.info.input",
    );
  });

  it("persists the declared OneSource GET query instead of its duplicated catalog body", () => {
    const candidate = normalizeTargetCandidate(
      resource({
        resourceUrl: "https://api.onesource.io/api/chain/network-info",
        extensions: {
          bazaar: {
            info: {
              input: {
                type: "http",
                method: "GET",
                queryParams: { network: "ethereum" },
                body: { network: "ethereum" },
              },
            },
          },
        },
      }),
    );
    expect(candidate.method).toBe("GET");
    expect(candidate.requestBinding).toMatchObject({
      endpoint: "https://api.onesource.io/api/chain/network-info",
      method: "GET",
      input_status: "known",
      query: [["network", "ethereum"]],
      body: null,
    });
    expect(candidate.requestBinding?.binding_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps USDC-on-Base candidates within budget", () => {
    const result = filterTargetCandidates([resource()], {
      maxTargetPriceAtomic: "10000",
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toEqual([]);
  });

  it("filters seller networks with version-aware exactness", () => {
    const v1Base = resource({
      x402Version: 1,
      accepts: [{ ...resource().accepts[0], network: "base" }],
    });
    const v1Caip = resource({
      resourceUrl: "https://v1-caip.example/x402",
      x402Version: 1,
      accepts: [{ ...resource().accepts[0], network: "eip155:8453" }],
    });
    const v2Alias = resource({
      resourceUrl: "https://v2-alias.example/x402",
      accepts: [{ ...resource().accepts[0], network: "base" }],
    });
    const result = filterTargetCandidates([v1Base, v1Caip, v2Alias]);
    expect(result.accepted.map((entry) => entry.resourceUrl)).toEqual([
      v1Base.resourceUrl,
    ]);
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "wrong_network",
      "wrong_network",
    ]);
  });

  it("rejects over-budget Base USDC candidates with an explicit reason", () => {
    const result = filterTargetCandidates(
      [resource({ accepts: [{ ...resource().accepts[0], amount: "10001" }] })],
      { maxTargetPriceAtomic: "10000" },
    );

    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      {
        resourceUrl: "https://seller.example/x402",
        reason: "over_budget",
        detail: "Cheapest Base USDC quote 10001 exceeds budget 10000",
      },
    ]);
  });

  it("rejects wrong network and wrong asset candidates", () => {
    const wrongNetwork = resource({
      resourceUrl: "https://network.example/x402",
      accepts: [{ ...resource().accepts[0], network: "eip155:84532" }],
    });
    const wrongAsset = resource({
      resourceUrl: "https://asset.example/x402",
      accepts: [
        {
          ...resource().accepts[0],
          asset: "0x0000000000000000000000000000000000000000",
        },
      ],
    });

    const result = filterTargetCandidates([wrongNetwork, wrongAsset], {
      maxTargetPriceAtomic: "10000",
    });

    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      "wrong_network",
      "wrong_asset",
    ]);
  });
});
