/**
 * payment-need-v1 — immutable payment-need provenance (B.6.2).
 * Explains WHY an external result is needed. Never authorizes spend.
 */

import {
  BLOCKED_B62_NEED_TAMPER,
  DUPLICATE_ACTIVE_NEED,
  GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY,
  NEED_LIFECYCLE_NOT_ACTIVE,
} from "./b62-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const PAYMENT_NEED_SCHEMA = "trustforge_payment_need.v1" as const;

export type NeedOriginType =
  | "HUMAN_REQUEST"
  | "AGENT_TASK"
  | "WORKFLOW_REQUIREMENT"
  | "SYSTEM_MAINTENANCE";

export type NeedAuthorityClass =
  | "EXPLICIT_HUMAN_NEED"
  | "DERIVED_TASK_NEED"
  | "WORKFLOW_BOUND_NEED"
  | "POLICY_BOUND_MAINTENANCE_NEED"
  | "UNSUPPORTED_NEED";

export type NeedLifecycleState =
  | "ACTIVE"
  | "SATISFIED"
  | "SUPERSEDED"
  | "CANCELLED"
  | "EXPIRED";

export type NeedUrgency = "low" | "medium" | "high" | "unspecified";

export interface NeedEvidenceItem {
  readonly kind: string;
  readonly ref: string;
  readonly detail: string | null;
}

export interface PaymentNeedConstraints {
  readonly notes: readonly string[];
  /** Explicit absence: empty object fields use nulls on parent. */
  readonly preferredPriceAtomic: string | null;
}

export interface PaymentNeedV1 {
  readonly needId: string;
  readonly schemaVersion: typeof PAYMENT_NEED_SCHEMA;
  readonly createdAt: string;
  readonly originType: NeedOriginType;
  readonly originRef: string;
  readonly parentTaskId: string | null;
  readonly parentTaskHash: string | null;
  readonly parentRequestedOutcome: string | null;
  readonly workflowId: string | null;
  readonly workflowVersion: string | null;
  readonly workflowStateHash: string | null;
  readonly requiredStep: string | null;
  readonly requestedOutcome: string;
  readonly needEvidence: readonly NeedEvidenceItem[];
  readonly constraints: PaymentNeedConstraints;
  readonly allowedCapabilities: readonly string[];
  readonly prohibitedCapabilities: readonly string[];
  readonly preferredNetworkConstraints: readonly string[];
  readonly preferredAssetConstraints: readonly string[];
  readonly budgetCeiling: string | null;
  readonly budgetAsset: string | null;
  readonly urgency: NeedUrgency;
  readonly informationFreshnessNeed:
    | { readonly kind: "none" }
    | { readonly kind: "max_age_ms"; readonly maxAgeMs: number }
    | { readonly kind: "unspecified" };
  readonly riskConstraints: readonly string[];
  readonly needAuthorityClass: NeedAuthorityClass;
  readonly lifecycleState: NeedLifecycleState;
  readonly derivationRationale: string | null;
  readonly needHash: string;
  readonly payment_authorized: false;
}

function needHashBody(
  need: Omit<PaymentNeedV1, "needHash">,
): Record<string, unknown> {
  return {
    needId: need.needId,
    schemaVersion: need.schemaVersion,
    createdAt: need.createdAt,
    originType: need.originType,
    originRef: need.originRef,
    parentTaskId: need.parentTaskId,
    parentTaskHash: need.parentTaskHash,
    parentRequestedOutcome: need.parentRequestedOutcome,
    workflowId: need.workflowId,
    workflowVersion: need.workflowVersion,
    workflowStateHash: need.workflowStateHash,
    requiredStep: need.requiredStep,
    requestedOutcome: need.requestedOutcome,
    needEvidence: need.needEvidence,
    constraints: need.constraints,
    allowedCapabilities: [...need.allowedCapabilities],
    prohibitedCapabilities: [...need.prohibitedCapabilities],
    preferredNetworkConstraints: [...need.preferredNetworkConstraints],
    preferredAssetConstraints: [...need.preferredAssetConstraints],
    budgetCeiling: need.budgetCeiling,
    budgetAsset: need.budgetAsset,
    urgency: need.urgency,
    informationFreshnessNeed: need.informationFreshnessNeed,
    riskConstraints: [...need.riskConstraints],
    needAuthorityClass: need.needAuthorityClass,
    lifecycleState: need.lifecycleState,
    derivationRationale: need.derivationRationale,
    payment_authorized: false,
  };
}

export function paymentNeedHash(
  need: Omit<PaymentNeedV1, "needHash"> | PaymentNeedV1,
): string {
  const { needHash: _h, ...rest } = need as PaymentNeedV1 & { needHash?: string };
  void _h;
  return canonicalJsonSha256(needHashBody(rest as Omit<PaymentNeedV1, "needHash">));
}

export function buildPaymentNeed(
  input: Omit<
    PaymentNeedV1,
    "needHash" | "payment_authorized" | "schemaVersion" | "needId"
  > & {
    readonly needId?: string;
  },
): PaymentNeedV1 {
  const provisionalId =
    input.needId ??
    canonicalJsonSha256({
      createdAt: input.createdAt,
      originType: input.originType,
      originRef: input.originRef,
      requestedOutcome: input.requestedOutcome,
      parentTaskHash: input.parentTaskHash,
    }).slice(0, 32);
  const partial: Omit<PaymentNeedV1, "needHash"> = {
    needId: provisionalId,
    schemaVersion: PAYMENT_NEED_SCHEMA,
    createdAt: input.createdAt,
    originType: input.originType,
    originRef: input.originRef,
    parentTaskId: input.parentTaskId,
    parentTaskHash: input.parentTaskHash,
    parentRequestedOutcome: input.parentRequestedOutcome,
    workflowId: input.workflowId,
    workflowVersion: input.workflowVersion,
    workflowStateHash: input.workflowStateHash,
    requiredStep: input.requiredStep,
    requestedOutcome: input.requestedOutcome,
    needEvidence: input.needEvidence,
    constraints: input.constraints,
    allowedCapabilities: input.allowedCapabilities,
    prohibitedCapabilities: input.prohibitedCapabilities,
    preferredNetworkConstraints: input.preferredNetworkConstraints,
    preferredAssetConstraints: input.preferredAssetConstraints,
    budgetCeiling: input.budgetCeiling,
    budgetAsset: input.budgetAsset,
    urgency: input.urgency,
    informationFreshnessNeed: input.informationFreshnessNeed,
    riskConstraints: input.riskConstraints,
    needAuthorityClass: input.needAuthorityClass,
    lifecycleState: input.lifecycleState,
    derivationRationale: input.derivationRationale,
    payment_authorized: false,
  };
  return { ...partial, needHash: paymentNeedHash(partial) };
}

export function assertNeedIntegrity(need: PaymentNeedV1): { readonly ok: true } {
  if (need.schemaVersion !== PAYMENT_NEED_SCHEMA) {
    throw new Error(`${BLOCKED_B62_NEED_TAMPER}: schemaVersion mismatch`);
  }
  if (need.payment_authorized !== false) {
    throw new Error(`${BLOCKED_B62_NEED_TAMPER}: payment_authorized must be false`);
  }
  if (paymentNeedHash(need) !== need.needHash) {
    throw new Error(`${BLOCKED_B62_NEED_TAMPER}: needHash mismatch`);
  }
  return { ok: true };
}

export function assertNeedActiveForObjective(need: PaymentNeedV1): void {
  assertNeedIntegrity(need);
  if (need.lifecycleState === "SATISFIED") {
    throw new Error(
      `${GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY}: need ${need.needId} is SATISFIED`,
    );
  }
  if (need.lifecycleState !== "ACTIVE") {
    throw new Error(
      `${NEED_LIFECYCLE_NOT_ACTIVE}: lifecycleState=${need.lifecycleState}`,
    );
  }
}

/** Material identity for duplicate active-need detection (not LLM similarity). */
export function activeNeedIdentityKey(need: PaymentNeedV1): string {
  return canonicalJsonSha256({
    requestedOutcome: need.requestedOutcome.trim().toLowerCase(),
    parentTaskId: need.parentTaskId,
    parentTaskHash: need.parentTaskHash,
    allowedCapabilities: [...need.allowedCapabilities].sort(),
    budgetCeiling: need.budgetCeiling,
    preferredNetworkConstraints: [...need.preferredNetworkConstraints].sort(),
    originType: need.originType,
  });
}

export function detectDuplicateActiveNeed(input: {
  readonly candidate: PaymentNeedV1;
  readonly activeNeeds: readonly PaymentNeedV1[];
}): { readonly duplicate: false } | { readonly duplicate: true; readonly code: typeof DUPLICATE_ACTIVE_NEED; readonly existingNeedId: string } {
  const key = activeNeedIdentityKey(input.candidate);
  for (const n of input.activeNeeds) {
    if (n.needId === input.candidate.needId) continue;
    if (n.lifecycleState !== "ACTIVE") continue;
    if (activeNeedIdentityKey(n) === key) {
      return {
        duplicate: true,
        code: DUPLICATE_ACTIVE_NEED,
        existingNeedId: n.needId,
      };
    }
  }
  return { duplicate: false };
}

export function withNeedLifecycle(
  need: PaymentNeedV1,
  lifecycleState: NeedLifecycleState,
): PaymentNeedV1 {
  return buildPaymentNeed({
    ...need,
    lifecycleState,
    needId: need.needId,
  });
}
