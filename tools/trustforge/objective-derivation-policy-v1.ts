/**
 * objective-derivation-policy-v1 — versioned deterministic need→objective mapping.
 */

import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const OBJECTIVE_DERIVATION_POLICY_ID =
  "trustforge_objective_derivation_policy" as const;
export const OBJECTIVE_DERIVATION_POLICY_VERSION = 1 as const;

export interface ObjectiveDerivationPolicyV1 {
  readonly id: typeof OBJECTIVE_DERIVATION_POLICY_ID;
  readonly version: typeof OBJECTIVE_DERIVATION_POLICY_VERSION;
  readonly payment_authorization: false;
  readonly notes: readonly string[];
  readonly defaults: {
    readonly minimumUtilityEvidenceClass: "ADVERTISED_UTILITY";
    readonly minimumEvidenceConfidence: "low";
    readonly riskTolerance: "medium";
    readonly diversityPreference: "unspecified";
  };
  /** Acceptable sibling outputs for derived capabilities. */
  readonly acceptableOutputClassesByCapability: Readonly<
    Record<string, readonly string[]>
  >;
}

export const OBJECTIVE_DERIVATION_POLICY_V1: ObjectiveDerivationPolicyV1 = {
  id: OBJECTIVE_DERIVATION_POLICY_ID,
  version: OBJECTIVE_DERIVATION_POLICY_VERSION,
  payment_authorization: false,
  notes: [
    "Candidate-independent derivation",
    "Objective constraints ⊆ need constraints",
    "NEED EXISTS != MAY SPEND",
  ],
  defaults: {
    minimumUtilityEvidenceClass: "ADVERTISED_UTILITY",
    minimumEvidenceConfidence: "low",
    riskTolerance: "medium",
    diversityPreference: "unspecified",
  },
  acceptableOutputClassesByCapability: {
    crypto_news: ["crypto_news", "market_brief"],
    market_brief: ["market_brief", "crypto_news"],
    chain_block_number: ["chain_block_number"],
    weather_forecast: ["weather_forecast"],
    market_information: ["crypto_news", "market_brief", "market_information"],
  },
};

export function objectiveDerivationPolicyHash(
  policy: ObjectiveDerivationPolicyV1 = OBJECTIVE_DERIVATION_POLICY_V1,
): string {
  return canonicalJsonSha256(policy);
}
