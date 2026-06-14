import { describe, expect, it, vi } from "vitest";

import {
  refreshRegistryUnpaid,
  selectSecondDeterministicService,
  type RefreshObservation,
  type RegistryDocument,
} from "../../tools/trustforge/refresh-registry-unpaid";

const fixedNow = () => new Date("2026-06-14T03:00:00.000Z");

function registry(): RegistryDocument {
  return {
    schema_name: "trustforge_service_registry",
    registry_version: "0.1.0",
    services: [
      {
        service_id: "onesource_api_chain_id",
        endpoint_url: "https://api.onesource.io/api/chain/chain-id?network=ethereum",
        method: "GET",
        network: "eip155:8453",
        asset: "USDC",
        last_observed_quote_usdc: "0.001",
      },
      {
        service_id: "onesource_api_block_number",
        endpoint_url: "https://api.onesource.io/api/chain/block-number?network=ethereum",
        method: "GET",
        network: "eip155:8453",
        asset: "USDC",
        last_observed_quote_usdc: "0.001",
      },
    ],
  };
}

function payment402(quoteAtomic: string): Response {
  const body = JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        maxAmountRequired: quoteAtomic,
        payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
        extra: { name: "USDC", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      },
    ],
  });
  return new Response(body, { status: 402, headers: { "content-type": "application/json" } });
}

describe("refreshRegistryUnpaid", () => {
  it("captures a live 402 with quote/network/asset, never paying", async () => {
    const fetchImpl = vi.fn(async () => payment402("1000")) as unknown as typeof fetch;
    const { report, updatedRegistry } = await refreshRegistryUnpaid(registry(), "run_x", {
      fetchImpl,
      now: fixedNow,
    });

    expect(report.services_total).toBe(2);
    expect(report.services_live_402).toBe(2);
    expect(report.services_failed).toBe(0);
    const obs = report.observations[0];
    expect(obs.refresh_status).toBe("live_402");
    expect(obs.observed_quote_usdc).toBe("0.001");
    expect(obs.observed_network).toBe("eip155:8453");
    expect(obs.observed_asset).toBe("USDC");
    expect(obs.quote_within_cap).toBe(true);
    // Plain unpaid GET only — no payment header ever attached.
    for (const call of fetchImpl.mock.calls) {
      const init = call[1] as RequestInit;
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain("x-payment");
      expect(init.method).toBe("GET");
    }
    // observed timestamp recorded; canonical quote untouched.
    expect((updatedRegistry.services[0] as Record<string, unknown>).observed_at_utc).toBe(
      "2026-06-14T03:00:00.000Z",
    );
    expect(updatedRegistry.services[0].last_observed_quote_usdc).toBe("0.001");
  });

  it("marks a non-402 endpoint as changed and a network error as failed", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))
      .mockRejectedValueOnce(new Error("ECONNRESET")) as unknown as typeof fetch;
    const { report } = await refreshRegistryUnpaid(registry(), "run_y", {
      fetchImpl,
      now: fixedNow,
    });
    expect(report.observations[0].refresh_status).toBe("changed");
    expect(report.observations[1].refresh_status).toBe("failed");
  });

  it("flags quote drift above the cap as not-within-cap", async () => {
    const fetchImpl = vi.fn(async () => payment402("6000")) as unknown as typeof fetch;
    const { report } = await refreshRegistryUnpaid(registry(), "run_z", {
      fetchImpl,
      now: fixedNow,
    });
    expect(report.observations[0].observed_quote_usdc).toBe("0.006");
    expect(report.observations[0].quote_within_cap).toBe(false);
  });
});

describe("selectSecondDeterministicService", () => {
  function obs(overrides: Partial<RefreshObservation>): RefreshObservation {
    return {
      service_id: "onesource_api_block_number",
      endpoint_url: "https://api.onesource.io/api/chain/block-number?network=ethereum",
      http_status: 402,
      refresh_status: "live_402",
      observed_quote_usdc: "0.001",
      observed_network: "eip155:8453",
      observed_asset: "USDC",
      observed_pay_to_present: true,
      quote_within_cap: true,
      drift_from_registry: false,
      latency_ms: 100,
      error: null,
      refreshed_at_utc: "2026-06-14T03:00:00.000Z",
      ...overrides,
    };
  }

  it("prefers block-number when eligible and excludes the T0C baseline service", () => {
    const selection = selectSecondDeterministicService(
      [
        obs({ service_id: "onesource_api_block_number" }),
        obs({ service_id: "onesource_api_network_info" }),
      ],
      { excludeServiceIds: ["onesource_api_chain_id"] },
    );
    expect(selection?.service_id).toBe("onesource_api_block_number");
  });

  it("falls back to network-info when block-number is not live", () => {
    const selection = selectSecondDeterministicService([
      obs({ service_id: "onesource_api_block_number", refresh_status: "failed", quote_within_cap: null }),
      obs({ service_id: "onesource_api_network_info" }),
    ]);
    expect(selection?.service_id).toBe("onesource_api_network_info");
  });

  it("returns null when nothing is eligible", () => {
    const selection = selectSecondDeterministicService([
      obs({ service_id: "onesource_api_block_number", quote_within_cap: false }),
    ]);
    expect(selection).toBeNull();
  });
});
