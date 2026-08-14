/**
 * derive-objective-from-need — candidate-independent objective derivation (B.6.2).
 */

import {
  GUARD_OBJECTIVE_DERIVATION_IS_CANDIDATE_INDEPENDENT,
  GUARD_OBJECTIVE_DOES_NOT_BROADEN_PAYMENT_NEED,
  GUARD_OBJECTIVE_REQUIRES_ESTABLISHED_PAYMENT_NEED,
  NO_ESTABLISHED_PAYMENT_NEED,
  OBJECTIVE_BROADENS_NEED_BUDGET,
  OBJECTIVE_BROADENS_NEED_CAPABILITY,
  OBJECTIVE_BROADENS_NEED_NETWORK,
  OBJECTIVE_NEED_MISMATCH,
} from "./b62-execution-gates";
import { normalizeCapabilityId } from "./capability-taxonomy-v1";
import { inferCapabilityFromOutcomeText } from "./need-capability-inference";
import type { NeedProvenanceAssessmentV1 } from "./need-provenance-assessment-v1";
import {
  buildObjectiveDerivationProof,
  type ObjectiveDerivationProofV1,
  type ObjectiveFieldMapping,
} from "./objective-derivation-proof-v1";
import {
  OBJECTIVE_DERIVATION_POLICY_V1,
  objectiveDerivationPolicyHash,
  type ObjectiveDerivationPolicyV1,
} from "./objective-derivation-policy-v1";
import {
  assertNeedActiveForObjective,
  type PaymentNeedV1,
} from "./payment-need-v1";
import {
  assertObjectiveIntegrity,
  buildPaymentDecisionObjective,
  sealObjectiveWithDerivationProof,
  type PaymentDecisionObjectiveV1,
} from "./payment-decision-objective-v1";

export interface DeriveObjectiveResult {
  readonly objective: PaymentDecisionObjectiveV1;
  readonly proof: ObjectiveDerivationProofV1;
}

/**
 * Derive a productive PaymentDecisionObjective from an ESTABLISHED need.
 * Must NOT accept candidate ranking/price/seller inputs.
 */
export function deriveObjectiveFromEstablishedNeed(input: {
  readonly need: PaymentNeedV1;
  readonly provenance: NeedProvenanceAssessmentV1;
  readonly policy?: ObjectiveDerivationPolicyV1;
  readonly now?: Date;
  /**
   * Structural marker: callers must not pass candidate data.
   * Presence of this bag fails closed if non-empty.
   */
  readonly forbiddenCandidateContext?: Readonly<Record<string, unknown>>;
}): DeriveObjectiveResult {
  void GUARD_OBJECTIVE_DERIVATION_IS_CANDIDATE_INDEPENDENT;
  void GUARD_OBJECTIVE_REQUIRES_ESTABLISHED_PAYMENT_NEED;
  void GUARD_OBJECTIVE_DOES_NOT_BROADEN_PAYMENT_NEED;

  if (
    input.forbiddenCandidateContext &&
    Object.keys(input.forbiddenCandidateContext).length > 0
  ) {
    throw new Error(
      `${GUARD_OBJECTIVE_DERIVATION_IS_CANDIDATE_INDEPENDENT}: candidate context supplied`,
    );
  }

  assertNeedActiveForObjective(input.need);
  if (input.provenance.needHash !== input.need.needHash) {
    throw new Error(`${OBJECTIVE_NEED_MISMATCH}: provenance needHash mismatch`);
  }
  if (input.provenance.provenanceStatus !== "ESTABLISHED") {
    throw new Error(
      `${NO_ESTABLISHED_PAYMENT_NEED}: provenanceStatus=${input.provenance.provenanceStatus}`,
    );
  }

  const policy = input.policy ?? OBJECTIVE_DERIVATION_POLICY_V1;
  const policyHash = objectiveDerivationPolicyHash(policy);
  const now = input.now ?? new Date();

  const capability =
    (input.need.allowedCapabilities[0]
      ? normalizeCapabilityId(input.need.allowedCapabilities[0])
      : null) ?? inferCapabilityFromOutcomeText(input.need.requestedOutcome);

  if (!capability) {
    throw new Error(
      `${NO_ESTABLISHED_PAYMENT_NEED}: cannot infer capability from requestedOutcome`,
    );
  }

  if (
    input.need.prohibitedCapabilities
      .map(normalizeCapabilityId)
      .includes(capability)
  ) {
    throw new Error(
      `${OBJECTIVE_BROADENS_NEED_CAPABILITY}: capability ${capability} is prohibited`,
    );
  }

  if (
    input.need.allowedCapabilities.length > 0 &&
    !input.need.allowedCapabilities
      .map(normalizeCapabilityId)
      .includes(capability)
  ) {
    throw new Error(
      `${OBJECTIVE_BROADENS_NEED_CAPABILITY}: ${capability} not in allowedCapabilities`,
    );
  }

  const acceptable =
    policy.acceptableOutputClassesByCapability[capability] ?? [capability];
  for (const c of acceptable) {
    if (
      input.need.prohibitedCapabilities.map(normalizeCapabilityId).includes(c)
    ) {
      throw new Error(
        `${OBJECTIVE_BROADENS_NEED_CAPABILITY}: acceptable class ${c} prohibited`,
      );
    }
  }

  const networks =
    input.need.preferredNetworkConstraints.length > 0
      ? [...input.need.preferredNetworkConstraints]
      : [];
  const assets =
    input.need.preferredAssetConstraints.length > 0
      ? [...input.need.preferredAssetConstraints]
      : [];

  const freshness =
    input.need.informationFreshnessNeed.kind === "max_age_ms"
      ? {
          kind: "max_age_ms" as const,
          maxAgeMs: input.need.informationFreshnessNeed.maxAgeMs,
          clock: "objective_information_freshness" as const,
        }
      : input.need.informationFreshnessNeed.kind === "none"
        ? { kind: "none" as const }
        : { kind: "unspecified" as const };

  // Build objective with need bindings; proof seal attached after without changing hash.
  const draft = buildPaymentDecisionObjective({
    createdAt: now.toISOString(),
    requestedCapability: capability,
    purpose: input.need.requestedOutcome,
    acceptableOutputClasses: [...acceptable],
    requiredProperties:
      capability === "chain_block_number" ? ["network=ethereum"] : [],
    preferredProperties: [],
    networkConstraints: networks,
    assetConstraints: assets,
    maxBudget: input.need.budgetCeiling,
    budgetAsset: input.need.budgetAsset,
    freshnessRequirement: freshness,
    minimumUtilityEvidenceClass: policy.defaults.minimumUtilityEvidenceClass,
    minimumEvidenceConfidence: policy.defaults.minimumEvidenceConfidence,
    providerConstraints: null,
    sellerConstraints: null,
    riskTolerance: policy.defaults.riskTolerance,
    diversityPreference: policy.defaults.diversityPreference,
    decisionContext: `derived_from_need:${input.need.needId}`,
    needId: input.need.needId,
    needHash: input.need.needHash,
    needProvenanceAssessmentHash: input.provenance.assessmentHash,
    objectiveDerivationProofHash: null,
  });

  assertObjectiveDoesNotBroadenNeed(input.need, draft);
  assertObjectiveIntegrity(draft);

  const fieldMappings: ObjectiveFieldMapping[] = [
    {
      objectiveField: "requestedCapability",
      source: {
        kind: "need_field",
        field:
          input.need.allowedCapabilities.length > 0
            ? "allowedCapabilities[0]"
            : "requestedOutcome",
      },
      value: capability,
    },
    {
      objectiveField: "purpose",
      source: { kind: "need_field", field: "requestedOutcome" },
      value: input.need.requestedOutcome,
    },
    {
      objectiveField: "maxBudget",
      source: { kind: "need_field", field: "budgetCeiling" },
      value: input.need.budgetCeiling,
    },
    {
      objectiveField: "networkConstraints",
      source: { kind: "need_field", field: "preferredNetworkConstraints" },
      value: networks,
    },
    {
      objectiveField: "acceptableOutputClasses",
      source: {
        kind: "policy_default",
        key: `acceptableOutputClassesByCapability.${capability}`,
      },
      value: acceptable,
    },
    {
      objectiveField: "minimumUtilityEvidenceClass",
      source: { kind: "policy_default", key: "defaults.minimumUtilityEvidenceClass" },
      value: policy.defaults.minimumUtilityEvidenceClass,
    },
  ];

  const proof = buildObjectiveDerivationProof({
    needId: input.need.needId,
    needHash: input.need.needHash,
    needProvenanceAssessmentHash: input.provenance.assessmentHash,
    objectiveId: draft.objectiveId,
    objectiveHash: draft.objectiveHash,
    fieldMappings,
    derivationPolicyId: policy.id,
    derivationPolicyVersion: policy.version,
    derivationPolicyHash: policyHash,
    unmappedNeedConstraints: input.need.riskConstraints.map(
      (r) => `riskConstraint:${r}`,
    ),
    introducedObjectiveConstraints: [],
    derivationStatus: "DERIVED",
  });

  const objective = sealObjectiveWithDerivationProof(draft, proof.proofHash);

  return { objective, proof };
}

export function assertObjectiveDoesNotBroadenNeed(
  need: PaymentNeedV1,
  objective: PaymentDecisionObjectiveV1,
): void {
  void GUARD_OBJECTIVE_DOES_NOT_BROADEN_PAYMENT_NEED;

  if (need.budgetCeiling !== null) {
    if (objective.maxBudget === null) {
      throw new Error(
        `${OBJECTIVE_BROADENS_NEED_BUDGET}: objective removed budget ceiling`,
      );
    }
    try {
      if (BigInt(objective.maxBudget) > BigInt(need.budgetCeiling)) {
        throw new Error(
          `${OBJECTIVE_BROADENS_NEED_BUDGET}: ${objective.maxBudget} > ${need.budgetCeiling}`,
        );
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes(OBJECTIVE_BROADENS_NEED_BUDGET)) {
        throw e;
      }
      throw new Error(`${OBJECTIVE_BROADENS_NEED_BUDGET}: invalid budget integers`);
    }
  }

  if (need.preferredNetworkConstraints.length > 0) {
    for (const n of objective.networkConstraints) {
      if (!need.preferredNetworkConstraints.includes(n)) {
        throw new Error(
          `${OBJECTIVE_BROADENS_NEED_NETWORK}: objective network ${n} not in need`,
        );
      }
    }
    // Objective may narrow; may not introduce networks outside need.
    // Empty objective networks when need has constraints would mean unconstrained → broaden
    if (objective.networkConstraints.length === 0) {
      throw new Error(
        `${OBJECTIVE_BROADENS_NEED_NETWORK}: objective dropped network constraints`,
      );
    }
  }

  const needAllowed = need.allowedCapabilities.map(normalizeCapabilityId);
  if (needAllowed.length > 0) {
    const req = normalizeCapabilityId(objective.requestedCapability);
    if (!needAllowed.includes(req)) {
      throw new Error(
        `${OBJECTIVE_BROADENS_NEED_CAPABILITY}: requestedCapability ${req} not allowed`,
      );
    }
    for (const c of objective.acceptableOutputClasses.map(normalizeCapabilityId)) {
      // acceptable siblings from policy are OK if not prohibited
      if (need.prohibitedCapabilities.map(normalizeCapabilityId).includes(c)) {
        throw new Error(
          `${OBJECTIVE_BROADENS_NEED_CAPABILITY}: acceptable ${c} prohibited by need`,
        );
      }
    }
  }

  // Capability mismatch vs inferred need outcome
  const inferred = inferCapabilityFromOutcomeText(need.requestedOutcome);
  if (
    inferred &&
    normalizeCapabilityId(objective.requestedCapability) !== inferred &&
    !(
      (inferred === "market_brief" &&
        objective.requestedCapability === "crypto_news") ||
      (inferred === "crypto_news" &&
        objective.requestedCapability === "market_brief") ||
      (inferred === "market_information" &&
        (objective.requestedCapability === "crypto_news" ||
          objective.requestedCapability === "market_brief"))
    )
  ) {
    // If need explicitly lists allowedCapabilities, that overrides pure text inference.
    if (needAllowed.length === 0 || !needAllowed.includes(normalizeCapabilityId(objective.requestedCapability))) {
      throw new Error(
        `${OBJECTIVE_NEED_MISMATCH}: objective capability ${objective.requestedCapability} vs need outcome ${inferred}`,
      );
    }
  }
}

/** Fail-closed check for manually constructed mismatched objective. */
export function assertObjectiveBindsNeed(input: {
  readonly need: PaymentNeedV1;
  readonly objective: PaymentDecisionObjectiveV1;
}): void {
  if (!input.objective.needHash || input.objective.needHash !== input.need.needHash) {
    throw new Error(`${OBJECTIVE_NEED_MISMATCH}: objective.needHash mismatch`);
  }
  if (!input.objective.needId || input.objective.needId !== input.need.needId) {
    throw new Error(`${OBJECTIVE_NEED_MISMATCH}: objective.needId mismatch`);
  }
  assertObjectiveDoesNotBroadenNeed(input.need, input.objective);
}
