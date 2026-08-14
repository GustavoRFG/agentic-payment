/**
 * need-provenance-assessment-v1 — structured provenance strength for PaymentNeed.
 */

import { UNSUPPORTED_NEED } from "./b62-execution-gates";
import {
  assertNeedIntegrity,
  type NeedAuthorityClass,
  type NeedOriginType,
  type PaymentNeedV1,
} from "./payment-need-v1";
import { inferCapabilityFromOutcomeText } from "./need-capability-inference";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const NEED_PROVENANCE_ASSESSMENT_SCHEMA =
  "trustforge_need_provenance_assessment.v1" as const;

export type NeedProvenanceStatus =
  | "ESTABLISHED"
  | "PARTIAL"
  | "UNSUPPORTED"
  | "CONTRADICTED";

export type ParentBindingStatus =
  | "BOUND"
  | "NOT_REQUIRED"
  | "MISSING"
  | "MISMATCH"
  | "ABSENT";

export interface NeedProvenanceAssessmentV1 {
  readonly schemaVersion: typeof NEED_PROVENANCE_ASSESSMENT_SCHEMA;
  readonly needId: string;
  readonly needHash: string;
  readonly originType: NeedOriginType;
  readonly originRef: string;
  readonly provenanceStatus: NeedProvenanceStatus;
  readonly parentBindingStatus: ParentBindingStatus;
  readonly requestedOutcomeEvidence: string;
  readonly scopeConsistency: "consistent" | "broadened" | "contradicted" | "unknown";
  readonly constraintConsistency: "consistent" | "inconsistent" | "unknown";
  readonly authorityClass: NeedAuthorityClass;
  readonly riskFlags: readonly string[];
  readonly rationale: string;
  readonly assessmentHash: string;
}

function assessmentHashBody(
  a: Omit<NeedProvenanceAssessmentV1, "assessmentHash">,
): Record<string, unknown> {
  return {
    schemaVersion: a.schemaVersion,
    needId: a.needId,
    needHash: a.needHash,
    originType: a.originType,
    originRef: a.originRef,
    provenanceStatus: a.provenanceStatus,
    parentBindingStatus: a.parentBindingStatus,
    requestedOutcomeEvidence: a.requestedOutcomeEvidence,
    scopeConsistency: a.scopeConsistency,
    constraintConsistency: a.constraintConsistency,
    authorityClass: a.authorityClass,
    riskFlags: [...a.riskFlags],
    rationale: a.rationale,
  };
}

export function needProvenanceAssessmentHash(
  a: Omit<NeedProvenanceAssessmentV1, "assessmentHash"> | NeedProvenanceAssessmentV1,
): string {
  const { assessmentHash: _h, ...rest } = a as NeedProvenanceAssessmentV1 & {
    assessmentHash?: string;
  };
  void _h;
  return canonicalJsonSha256(
    assessmentHashBody(rest as Omit<NeedProvenanceAssessmentV1, "assessmentHash">),
  );
}

/**
 * Assess need provenance. Candidate availability must NOT be an input.
 */
export function assessNeedProvenance(
  need: PaymentNeedV1,
  options?: {
    readonly maintenancePolicyAuthorized?: boolean;
    /** Marks needs invented from candidate discovery (self-justification). */
    readonly candidateFirstSelfJustification?: boolean;
  },
): NeedProvenanceAssessmentV1 {
  assertNeedIntegrity(need);
  const riskFlags: string[] = [];
  let provenanceStatus: NeedProvenanceStatus = "UNSUPPORTED";
  let parentBindingStatus: ParentBindingStatus = "ABSENT";
  let scopeConsistency: NeedProvenanceAssessmentV1["scopeConsistency"] = "unknown";
  let constraintConsistency: NeedProvenanceAssessmentV1["constraintConsistency"] =
    "unknown";
  let authorityClass: NeedAuthorityClass = need.needAuthorityClass;
  let rationale = "";

  if (options?.candidateFirstSelfJustification) {
    riskFlags.push("candidate_first_self_justification");
    provenanceStatus = "UNSUPPORTED";
    authorityClass = "UNSUPPORTED_NEED";
    rationale = `${UNSUPPORTED_NEED}: need invented from candidate availability without upstream origin`;
  } else if (need.originType === "HUMAN_REQUEST") {
    parentBindingStatus = "NOT_REQUIRED";
    if (!need.originRef || need.originRef.trim() === "") {
      provenanceStatus = "UNSUPPORTED";
      rationale = "HUMAN_REQUEST missing originRef";
      authorityClass = "UNSUPPORTED_NEED";
    } else if (!need.requestedOutcome.trim()) {
      provenanceStatus = "UNSUPPORTED";
      rationale = "HUMAN_REQUEST missing requestedOutcome";
      authorityClass = "UNSUPPORTED_NEED";
    } else if (need.needEvidence.length === 0) {
      provenanceStatus = "PARTIAL";
      rationale = "HUMAN_REQUEST lacks structured needEvidence";
      authorityClass = "EXPLICIT_HUMAN_NEED";
    } else {
      provenanceStatus = "ESTABLISHED";
      scopeConsistency = "consistent";
      constraintConsistency = "consistent";
      authorityClass = "EXPLICIT_HUMAN_NEED";
      rationale = `EXPLICIT_HUMAN_NEED bound to originRef=${need.originRef}`;
    }
  } else if (need.originType === "AGENT_TASK") {
    if (!need.parentTaskId || !need.parentTaskHash || !need.parentRequestedOutcome) {
      parentBindingStatus = "MISSING";
      provenanceStatus = "UNSUPPORTED";
      authorityClass = "UNSUPPORTED_NEED";
      rationale = "AGENT_TASK requires parentTaskId/parentTaskHash/parentRequestedOutcome";
      riskFlags.push("missing_parent_binding");
    } else {
      parentBindingStatus = "BOUND";
      const parentCap = inferCapabilityFromOutcomeText(need.parentRequestedOutcome);
      const needCap =
        need.allowedCapabilities[0] ??
        inferCapabilityFromOutcomeText(need.requestedOutcome);
      if (
        parentCap &&
        needCap &&
        parentCap !== needCap &&
        !isCompatibleDerivation(parentCap, needCap)
      ) {
        parentBindingStatus = "MISMATCH";
        provenanceStatus = "CONTRADICTED";
        scopeConsistency = "contradicted";
        authorityClass = "UNSUPPORTED_NEED";
        rationale = `derived need capability ${needCap} contradicts parent outcome capability ${parentCap}`;
        riskFlags.push("parent_capability_contradiction");
      } else if (!need.derivationRationale) {
        provenanceStatus = "PARTIAL";
        authorityClass = "DERIVED_TASK_NEED";
        rationale = "AGENT_TASK missing derivationRationale";
      } else {
        provenanceStatus = "ESTABLISHED";
        scopeConsistency = "consistent";
        constraintConsistency = "consistent";
        authorityClass = "DERIVED_TASK_NEED";
        rationale = `DERIVED_TASK_NEED from parent=${need.parentTaskId}`;
      }
    }
  } else if (need.originType === "WORKFLOW_REQUIREMENT") {
    if (
      !need.workflowId ||
      !need.workflowVersion ||
      !need.workflowStateHash ||
      !need.requiredStep
    ) {
      provenanceStatus = "UNSUPPORTED";
      authorityClass = "UNSUPPORTED_NEED";
      rationale = "WORKFLOW_REQUIREMENT missing workflow identity/step binding";
      riskFlags.push("missing_workflow_binding");
    } else if (
      need.needEvidence.some((e) => e.kind === "workflow_generally_benefits")
    ) {
      provenanceStatus = "UNSUPPORTED";
      authorityClass = "UNSUPPORTED_NEED";
      rationale = "vague workflow benefit is insufficient provenance";
      riskFlags.push("vague_workflow_benefit");
    } else {
      provenanceStatus = "ESTABLISHED";
      parentBindingStatus = "BOUND";
      scopeConsistency = "consistent";
      constraintConsistency = "consistent";
      authorityClass = "WORKFLOW_BOUND_NEED";
      rationale = `WORKFLOW_BOUND_NEED workflow=${need.workflowId}@${need.workflowVersion} step=${need.requiredStep}`;
    }
  } else if (need.originType === "SYSTEM_MAINTENANCE") {
    if (!options?.maintenancePolicyAuthorized) {
      provenanceStatus = "UNSUPPORTED";
      authorityClass = "UNSUPPORTED_NEED";
      rationale = "SYSTEM_MAINTENANCE without explicit maintenance policy";
      riskFlags.push("maintenance_policy_absent");
    } else {
      provenanceStatus = "ESTABLISHED";
      parentBindingStatus = "BOUND";
      authorityClass = "POLICY_BOUND_MAINTENANCE_NEED";
      scopeConsistency = "consistent";
      constraintConsistency = "consistent";
      rationale = "POLICY_BOUND_MAINTENANCE_NEED authorized by explicit policy";
    }
  }

  if (need.lifecycleState !== "ACTIVE" && provenanceStatus === "ESTABLISHED") {
    // Lifecycle gate is separate; mark risk but keep assessment of origin.
    riskFlags.push(`lifecycle_${need.lifecycleState.toLowerCase()}`);
  }

  const partial: Omit<NeedProvenanceAssessmentV1, "assessmentHash"> = {
    schemaVersion: NEED_PROVENANCE_ASSESSMENT_SCHEMA,
    needId: need.needId,
    needHash: need.needHash,
    originType: need.originType,
    originRef: need.originRef,
    provenanceStatus,
    parentBindingStatus,
    requestedOutcomeEvidence: need.requestedOutcome,
    scopeConsistency,
    constraintConsistency,
    authorityClass,
    riskFlags,
    rationale,
  };
  return {
    ...partial,
    assessmentHash: needProvenanceAssessmentHash(partial),
  };
}

function isCompatibleDerivation(parentCap: string, needCap: string): boolean {
  // market brief parent may derive crypto_news need
  if (parentCap === "market_information" && needCap === "crypto_news") return true;
  if (parentCap === "crypto_news" && needCap === "market_brief") return true;
  if (parentCap === "market_brief" && needCap === "crypto_news") return true;
  return parentCap === needCap;
}
