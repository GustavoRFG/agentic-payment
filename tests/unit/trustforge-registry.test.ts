import { describe, expect, it } from "vitest";

import { readJson, repoPath, validateAgainst } from "../../tools/trustforge/contracts";

interface RegistryService {
  service_id: string;
  provider: string;
  category: string;
  endpoint_url: string;
  method: string;
  network: string;
  asset: string;
  last_observed_quote_usdc: string;
  ground_truth_strategy: string;
  status: string;
  evidence_refs: string[];
}

const registry = readJson(
  repoPath("trustforge", "registry", "services.bootstrap.json"),
) as { registry_version: string; services: RegistryService[] };

// The set of provider slugs that were actually proven by handshake in spike-zero.
const PROVEN_SLUGS = new Set([
  "anchor_token_price_eth",
  "bazaar_gateway_weather_london",
  "blockrun_polymarket_markets",
  "geo_memory_weather_london",
  "onesource_api_block_number",
  "onesource_api_chain_id",
  "onesource_api_network_info",
  "otto_crypto_news",
  "otto_hyperliquid_btc",
  "otto_token_price_eth",
]);

const ALLOWED_CATEGORIES = new Set([
  "chain_metadata",
  "market_data",
  "prediction_market",
  "weather",
  "news",
]);

describe("TrustForge registry bootstrap", () => {
  it("validates against the service_registry contract", () => {
    expect(validateAgainst("service_registry", registry)).toEqual([]);
  });

  it("contains 5–8 services", () => {
    expect(registry.services.length).toBeGreaterThanOrEqual(5);
    expect(registry.services.length).toBeLessThanOrEqual(8);
  });

  it("has unique service ids", () => {
    const ids = registry.services.map((s) => s.service_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes the mandatory onesource_api_chain_id", () => {
    expect(registry.services.some((s) => s.service_id === "onesource_api_chain_id")).toBe(true);
  });

  it("uses only HTTPS endpoints", () => {
    for (const s of registry.services) {
      expect(s.endpoint_url.startsWith("https://")).toBe(true);
    }
  });

  it("uses valid categories", () => {
    for (const s of registry.services) {
      expect(ALLOWED_CATEGORIES.has(s.category)).toBe(true);
    }
  });

  it("has non-empty evidence refs for every service", () => {
    for (const s of registry.services) {
      expect(Array.isArray(s.evidence_refs)).toBe(true);
      expect(s.evidence_refs.length).toBeGreaterThan(0);
    }
  });

  it("invents no services — every id was proven in spike-zero", () => {
    for (const s of registry.services) {
      expect(PROVEN_SLUGS.has(s.service_id)).toBe(true);
    }
  });

  it("keeps every service on Base mainnet USDC GET with quote <= 0.005", () => {
    for (const s of registry.services) {
      expect(s.network).toBe("eip155:8453");
      expect(s.asset).toBe("USDC");
      expect(s.method).toBe("GET");
      expect(Number(s.last_observed_quote_usdc)).toBeLessThanOrEqual(0.005);
    }
  });
});
