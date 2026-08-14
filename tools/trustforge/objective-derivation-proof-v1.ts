/**
 * objective-derivation-proof-v1 — auditable need→objective field mapping.
 */

import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const OBJECTIVE_DERIVATION_PROOF_SCHEMA =
  "trustforge_objective_derivation_proof.v1" as const;

export type DerivationStatus = "DERIVED" | "REJECTED" | "BLOCKED";

export interface ObjectiveFieldMapping {
  readonly objectiveField: string;
  readonly source:
    | { readonly kind: "need_field"; readonly field: string }
    | { readonly kind: "policy_default"; readonly key: string }
    | { readonly kind: "permitted_refinement"; readonly detail: string };
  readonly value: unknown;
}

export interface ObjectiveDerivationProofV1 {
  readonly schemaVersion: typeof OBJECTIVE_DERIVATION_PROOF_SCHEMA;
  readonly needId: string;
  readonly needHash: string;
  readonly needProvenanceAssessmentHash: string;
  readonly objectiveId: string;
  readonly objectiveHash: string;
  readonly fieldMappings: readonly ObjectiveFieldMapping[];
  readonly derivationPolicyId: string;
  readonly derivationPolicyVersion: number;
  readonly derivationPolicyHash: string;
  readonly unmappedNeedConstraints: readonly string[];
  readonly introducedObjectiveConstraints: readonly string[];
  readonly derivationStatus: DerivationStatus;
  readonly proofHash: string;
}

function proofHashBody(
  p: Omit<ObjectiveDerivationProofV1, "proofHash">,
): Record<string, unknown> {
  return {
    schemaVersion: p.schemaVersion,
    needId: p.needId,
    needHash: p.needHash,
    needProvenanceAssessmentHash: p.needProvenanceAssessmentHash,
    objectiveId: p.objectiveId,
    objectiveHash: p.objectiveHash,
    fieldMappings: p.fieldMappings,
    derivationPolicyId: p.derivationPolicyId,
    derivationPolicyVersion: p.derivationPolicyVersion,
    derivationPolicyHash: p.derivationPolicyHash,
    unmappedNeedConstraints: [...p.unmappedNeedConstraints],
    introducedObjectiveConstraints: [...p.introducedObjectiveConstraints],
    derivationStatus: p.derivationStatus,
  };
}

export function objectiveDerivationProofHash(
  p: Omit<ObjectiveDerivationProofV1, "proofHash"> | ObjectiveDerivationProofV1,
): string {
  const { proofHash: _h, ...rest } = p as ObjectiveDerivationProofV1 & {
    proofHash?: string;
  };
  void _h;
  return canonicalJsonSha256(
    proofHashBody(rest as Omit<ObjectiveDerivationProofV1, "proofHash">),
  );
}

export function buildObjectiveDerivationProof(
  input: Omit<ObjectiveDerivationProofV1, "proofHash" | "schemaVersion">,
): ObjectiveDerivationProofV1 {
  const partial: Omit<ObjectiveDerivationProofV1, "proofHash"> = {
    schemaVersion: OBJECTIVE_DERIVATION_PROOF_SCHEMA,
    ...input,
  };
  return { ...partial, proofHash: objectiveDerivationProofHash(partial) };
}
