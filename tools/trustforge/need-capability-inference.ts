/**
 * need-capability-inference — deterministic outcome-text → capability mapping.
 * Explicit keyword rules only. No LLM similarity authority.
 */

import { normalizeCapabilityId } from "./capability-taxonomy-v1";

export function inferCapabilityFromOutcomeText(text: string): string | null {
  const t = text.toLowerCase();
  if (
    /block\s*number|block_number|chain.?block|ethereum block|eth block/.test(t)
  ) {
    return "chain_block_number";
  }
  if (/crypto.?news|market brief|market.?information|crypto market/.test(t)) {
    if (/market brief/.test(t) && !/crypto.?news/.test(t)) {
      return "market_brief";
    }
    return "crypto_news";
  }
  if (/weather|forecast/.test(t)) {
    return "weather_forecast";
  }
  // If already a capability id
  const normalized = normalizeCapabilityId(text);
  if (
    normalized === "crypto_news" ||
    normalized === "chain_block_number" ||
    normalized === "market_brief" ||
    normalized === "weather_forecast" ||
    normalized === "market_information"
  ) {
    return normalized;
  }
  return null;
}
