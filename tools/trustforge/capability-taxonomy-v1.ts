/**
 * capability-taxonomy-v1 — minimal inspectable capability IDs for B.6.1.
 * No LLM similarity. Explicit deterministic aliases only.
 */

export const CAPABILITY_TAXONOMY_SCHEMA =
  "trustforge_capability_taxonomy.v1" as const;

/** Capabilities evidenced by the current TrustForge candidate ecosystem. */
export const KNOWN_CAPABILITIES = [
  "chain_block_number",
  "crypto_news",
  "market_brief",
  "market_information",
  "weather_forecast",
] as const;

export type KnownCapability = (typeof KNOWN_CAPABILITIES)[number];

/**
 * Deterministic compatibility edges:
 * - child may satisfy parent when objective requests the parent
 * - siblings listed in acceptableOutputClasses are handled by matching logic
 * - NO edge from chain_block_number → crypto_news (or reverse)
 */
export const CAPABILITY_MAY_SATISFY: Readonly<
  Record<string, readonly string[]>
> = {
  crypto_news: ["market_information"],
  market_brief: ["market_information", "crypto_news"],
  chain_block_number: [],
  weather_forecast: [],
  market_information: [],
};

export interface CapabilityTaxonomyV1 {
  readonly schemaVersion: typeof CAPABILITY_TAXONOMY_SCHEMA;
  readonly capabilities: readonly string[];
  readonly maySatisfy: Readonly<Record<string, readonly string[]>>;
  readonly notes: readonly string[];
}

export const CAPABILITY_TAXONOMY_V1: CapabilityTaxonomyV1 = {
  schemaVersion: CAPABILITY_TAXONOMY_SCHEMA,
  capabilities: [...KNOWN_CAPABILITIES],
  maySatisfy: CAPABILITY_MAY_SATISFY,
  notes: [
    "Explicit deterministic aliases only — no LLM semantic similarity authority",
    "chain_block_number must NOT satisfy crypto_news",
    "crypto_news may satisfy market_information",
  ],
};

export function normalizeCapabilityId(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (
    s === "block_number" ||
    s === "ethereum_block_number" ||
    s === "eth_block_number" ||
    s === "chain_block_number"
  ) {
    return "chain_block_number";
  }
  if (s === "crypto_news" || s === "cryptonews") {
    return "crypto_news";
  }
  if (s === "market_brief" || s === "marketbrief") {
    return "market_brief";
  }
  if (s === "market_information" || s === "market_info") {
    return "market_information";
  }
  if (s === "weather" || s === "weather_forecast" || s === "forecast") {
    return "weather_forecast";
  }
  return s;
}

export function capabilityMaySatisfy(
  candidateCapability: string,
  requestedCapability: string,
): boolean {
  const cand = normalizeCapabilityId(candidateCapability);
  const req = normalizeCapabilityId(requestedCapability);
  if (cand === req) return true;
  const parents = CAPABILITY_MAY_SATISFY[cand] ?? [];
  return parents.includes(req);
}
