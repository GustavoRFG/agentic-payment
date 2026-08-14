/**
 * payment-decision-objective-v1 — immutable payment-decision objective (B.6.1).
 * Constrains selection BEFORE economic ranking. Never authorizes payment.
 */

import {
  BLOCKED_B61_OBJECTIVE_TAMPER,
  OBJECTIVE_REQUIRED,
} from "./b61-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const PAYMENT_DECISION_OBJECTIVE_SCHEMA =
  "trustforge_payment_decision_objective.v1" as const;

export type RiskTolerance = "low" | "medium" | "high" | "unspecified";
export type DiversityPreference =
  | "none"
  | "prefer_new_provider"
  | "prefer_known_provider"
  | "unspecified";

export type FreshnessRequirement =
  | { readonly kind: "none" }
  | {
      readonly kind: "max_age_ms";
      readonly maxAgeMs: number;
      readonly clock: "objective_information_freshness";
    }
  | { readonly kind: "unspecified" };

export type UtilityEvidenceClassMinimum =
  | "ADVERTISED_UTILITY"
  | "INFERRED_UTILITY"
  | "OBSERVED_UTILITY"
  | "UNKNOWN_UTILITY"
  | "unspecified";

export type EvidenceConfidenceMinimum =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "unspecified";

/**
 * Explicit absence: optional fields use null or "unspecified" rather than
 * silent defaults that could change selection authority.
 */
export interface PaymentDecisionObjectiveV1 {
  readonly objectiveId: string;
  readonly schemaVersion: typeof PAYMENT_DECISION_OBJECTIVE_SCHEMA;
  readonly createdAt: string;
  readonly requestedCapability: string;
  readonly purpose: string;
  readonly acceptableOutputClasses: readonly string[];
  readonly requiredProperties: readonly string[];
  readonly preferredProperties: readonly string[];
  readonly networkConstraints: readonly string[];
  readonly assetConstraints: readonly string[];
  /** Atomic integer string, or null when unconstrained. */
  readonly maxBudget: string | null;
  readonly budgetAsset: string | null;
  readonly freshnessRequirement: FreshnessRequirement;
  readonly minimumUtilityEvidenceClass: UtilityEvidenceClassMinimum;
  readonly minimumEvidenceConfidence: EvidenceConfidenceMinimum;
  readonly providerConstraints: readonly string[] | null;
  readonly sellerConstraints: readonly string[] | null;
  readonly riskTolerance: RiskTolerance;
  readonly diversityPreference: DiversityPreference;
  readonly decisionContext: string | null;
  readonly objectiveHash: string;
  readonly payment_authorized: false;
  /** B.6.2: upstream need binding (null for legacy B6.1-only objectives). */
  readonly needId?: string | null;
  readonly needHash?: string | null;
  readonly needProvenanceAssessmentHash?: string | null;
  readonly objectiveDerivationProofHash?: string | null;
}

function objectiveHashBody(
  objective: Omit<PaymentDecisionObjectiveV1, "objectiveHash">,
): Record<string, unknown> {
  return {
    objectiveId: objective.objectiveId,
    schemaVersion: objective.schemaVersion,
    createdAt: objective.createdAt,
    requestedCapability: objective.requestedCapability,
    purpose: objective.purpose,
    acceptableOutputClasses: [...objective.acceptableOutputClasses],
    requiredProperties: [...objective.requiredProperties],
    preferredProperties: [...objective.preferredProperties],
    networkConstraints: [...objective.networkConstraints],
    assetConstraints: [...objective.assetConstraints],
    maxBudget: objective.maxBudget,
    budgetAsset: objective.budgetAsset,
    freshnessRequirement: objective.freshnessRequirement,
    minimumUtilityEvidenceClass: objective.minimumUtilityEvidenceClass,
    minimumEvidenceConfidence: objective.minimumEvidenceConfidence,
    providerConstraints: objective.providerConstraints,
    sellerConstraints: objective.sellerConstraints,
    riskTolerance: objective.riskTolerance,
    diversityPreference: objective.diversityPreference,
    decisionContext: objective.decisionContext,
    payment_authorized: false,
    needId: objective.needId ?? null,
    needHash: objective.needHash ?? null,
    needProvenanceAssessmentHash: objective.needProvenanceAssessmentHash ?? null,
    // objectiveDerivationProofHash is attached after hashing (seal); not part of identity hash
  };
}

export function paymentDecisionObjectiveHash(
  objective:
    | Omit<PaymentDecisionObjectiveV1, "objectiveHash">
    | PaymentDecisionObjectiveV1,
): string {
  const { objectiveHash: _h, ...rest } = objective as PaymentDecisionObjectiveV1 & {
    objectiveHash?: string;
  };
  void _h;
  return canonicalJsonSha256(
    objectiveHashBody(rest as Omit<PaymentDecisionObjectiveV1, "objectiveHash">),
  );
}

export function buildPaymentDecisionObjective(
  input: Omit<
    PaymentDecisionObjectiveV1,
    "objectiveHash" | "payment_authorized" | "schemaVersion" | "objectiveId"
  > & {
    readonly objectiveId?: string;
  },
): PaymentDecisionObjectiveV1 {
  const provisionalId =
    input.objectiveId ??
    canonicalJsonSha256({
      createdAt: input.createdAt,
      requestedCapability: input.requestedCapability,
      purpose: input.purpose,
      maxBudget: input.maxBudget,
      acceptableOutputClasses: input.acceptableOutputClasses,
    }).slice(0, 32);
  const partial: Omit<PaymentDecisionObjectiveV1, "objectiveHash"> = {
    objectiveId: provisionalId,
    schemaVersion: PAYMENT_DECISION_OBJECTIVE_SCHEMA,
    createdAt: input.createdAt,
    requestedCapability: input.requestedCapability,
    purpose: input.purpose,
    acceptableOutputClasses: input.acceptableOutputClasses,
    requiredProperties: input.requiredProperties,
    preferredProperties: input.preferredProperties,
    networkConstraints: input.networkConstraints,
    assetConstraints: input.assetConstraints,
    maxBudget: input.maxBudget,
    budgetAsset: input.budgetAsset,
    freshnessRequirement: input.freshnessRequirement,
    minimumUtilityEvidenceClass: input.minimumUtilityEvidenceClass,
    minimumEvidenceConfidence: input.minimumEvidenceConfidence,
    providerConstraints: input.providerConstraints,
    sellerConstraints: input.sellerConstraints,
    riskTolerance: input.riskTolerance,
    diversityPreference: input.diversityPreference,
    decisionContext: input.decisionContext,
    payment_authorized: false,
    needId: input.needId ?? null,
    needHash: input.needHash ?? null,
    needProvenanceAssessmentHash: input.needProvenanceAssessmentHash ?? null,
    objectiveDerivationProofHash: input.objectiveDerivationProofHash ?? null,
  };
  const hash = paymentDecisionObjectiveHash(partial);
  return {
    ...partial,
    objectiveHash: hash,
  };
}

/** Attach derivation proof seal without changing objectiveHash. */
export function sealObjectiveWithDerivationProof(
  objective: PaymentDecisionObjectiveV1,
  proofHash: string,
): PaymentDecisionObjectiveV1 {
  return {
    ...objective,
    objectiveDerivationProofHash: proofHash,
  };
}

export function assertObjectiveIntegrity(
  objective: PaymentDecisionObjectiveV1,
): { readonly ok: true } {
  if (objective.schemaVersion !== PAYMENT_DECISION_OBJECTIVE_SCHEMA) {
    throw new Error(`${BLOCKED_B61_OBJECTIVE_TAMPER}: schemaVersion mismatch`);
  }
  if (objective.payment_authorized !== false) {
    throw new Error(`${BLOCKED_B61_OBJECTIVE_TAMPER}: payment_authorized must be false`);
  }
  const expected = paymentDecisionObjectiveHash(objective);
  if (objective.objectiveHash !== expected) {
    throw new Error(`${BLOCKED_B61_OBJECTIVE_TAMPER}: objectiveHash mismatch`);
  }
  if (!objective.requestedCapability || objective.requestedCapability.trim() === "") {
    throw new Error(`${OBJECTIVE_REQUIRED}: requestedCapability empty`);
  }
  return { ok: true };
}

/** Convenience builders for live unpaid exercises. */
export function buildCryptoNewsObjective(input: {
  readonly createdAt: string;
  readonly maxBudgetAtomic?: string;
}): PaymentDecisionObjectiveV1 {
  return buildPaymentDecisionObjective({
    createdAt: input.createdAt,
    requestedCapability: "crypto_news",
    purpose: "obtain current crypto news / market brief",
    acceptableOutputClasses: ["crypto_news", "market_brief"],
    requiredProperties: [],
    preferredProperties: ["recent_headlines"],
    networkConstraints: ["eip155:8453"],
    assetConstraints: ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    maxBudget: input.maxBudgetAtomic ?? "1000",
    budgetAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    freshnessRequirement: {
      kind: "max_age_ms",
      maxAgeMs: 3_600_000,
      clock: "objective_information_freshness",
    },
    minimumUtilityEvidenceClass: "ADVERTISED_UTILITY",
    minimumEvidenceConfidence: "low",
    providerConstraints: null,
    sellerConstraints: null,
    riskTolerance: "medium",
    diversityPreference: "unspecified",
    decisionContext: "b61_live_unpaid_crypto_news",
  });
}

export function buildChainBlockNumberObjective(input: {
  readonly createdAt: string;
  readonly maxBudgetAtomic?: string;
}): PaymentDecisionObjectiveV1 {
  return buildPaymentDecisionObjective({
    createdAt: input.createdAt,
    requestedCapability: "chain_block_number",
    purpose: "obtain current Ethereum block number",
    acceptableOutputClasses: ["chain_block_number"],
    requiredProperties: ["network=ethereum"],
    preferredProperties: [],
    networkConstraints: ["eip155:8453"],
    assetConstraints: ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    maxBudget: input.maxBudgetAtomic ?? "1000",
    budgetAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    freshnessRequirement: {
      kind: "max_age_ms",
      maxAgeMs: 120_000,
      clock: "objective_information_freshness",
    },
    minimumUtilityEvidenceClass: "ADVERTISED_UTILITY",
    minimumEvidenceConfidence: "low",
    providerConstraints: null,
    sellerConstraints: null,
    riskTolerance: "medium",
    diversityPreference: "unspecified",
    decisionContext: "b61_live_unpaid_block_number",
  });
}

export function buildWeatherForecastObjective(input: {
  readonly createdAt: string;
}): PaymentDecisionObjectiveV1 {
  return buildPaymentDecisionObjective({
    createdAt: input.createdAt,
    requestedCapability: "weather_forecast",
    purpose: "obtain a weather forecast",
    acceptableOutputClasses: ["weather_forecast"],
    requiredProperties: [],
    preferredProperties: [],
    networkConstraints: ["eip155:8453"],
    assetConstraints: ["USDC"],
    maxBudget: "1000",
    budgetAsset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    freshnessRequirement: { kind: "none" },
    minimumUtilityEvidenceClass: "ADVERTISED_UTILITY",
    minimumEvidenceConfidence: "low",
    providerConstraints: null,
    sellerConstraints: null,
    riskTolerance: "medium",
    diversityPreference: "unspecified",
    decisionContext: "b61_no_relevant_candidate",
  });
}
