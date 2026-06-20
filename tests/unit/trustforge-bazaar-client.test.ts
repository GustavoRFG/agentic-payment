import { describe, expect, it, vi } from "vitest";

import {
  BazaarClient,
  DEFAULT_BAZAAR_FACILITATOR_URL,
  normalizeBazaarResource,
  resolveBazaarFacilitatorUrl,
} from "../../tools/trustforge/bazaar-client";

const listResourcesMock = vi.fn();

vi.mock("@x402/core/http", () => ({
  HTTPFacilitatorClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@x402/extensions", () => ({
  withBazaar: vi.fn(() => ({
    extensions: {
      bazaar: {
        listResources: listResourcesMock,
      },
    },
  })),
}));

describe("BazaarClient discovery wrapper", () => {
  it("defaults to the public x402 facilitator and allows env override", () => {
    expect(resolveBazaarFacilitatorUrl({})).toBe(DEFAULT_BAZAAR_FACILITATOR_URL);
    expect(
      resolveBazaarFacilitatorUrl({
        TRUSTFORGE_BAZAAR_FACILITATOR_URL: "https://facilitator.example",
      }),
    ).toBe("https://facilitator.example");
  });

  it("normalizes SDK resources into TrustForge-owned shapes", () => {
    const resource = normalizeBazaarResource({
      resource: "https://seller.example/x402",
      type: "http",
      x402Version: 2,
      lastUpdated: "2026-06-20T00:00:00.000Z",
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1000",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 300,
          extra: { name: "USDC" },
        },
      ],
      extensions: { bazaar: { score: "ignored" } },
    });

    expect(resource).toEqual({
      resourceUrl: "https://seller.example/x402",
      type: "http",
      x402Version: 2,
      lastUpdated: "2026-06-20T00:00:00.000Z",
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "1000",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 300,
          extra: { name: "USDC" },
        },
      ],
      extensions: { bazaar: { score: "ignored" } },
    });
  });

  it("surfaces a shape mismatch instead of returning an empty ok result", async () => {
    listResourcesMock.mockResolvedValueOnce({ resources: [] });

    const result = await new BazaarClient({
      facilitatorUrl: "https://facilitator.example",
    }).listHttpResources();

    expect(result).toEqual({
      ok: false,
      facilitatorUrl: "https://facilitator.example",
      resources: [],
      rawCount: 0,
      error: "bazaar response missing items[] (shape mismatch)",
    });
  });
});
