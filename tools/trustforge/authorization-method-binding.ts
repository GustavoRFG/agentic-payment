/**
 * authorization-method-binding — pre-live gate binding the human-authorized HTTP
 * method to every downstream method decision.
 *
 * A.2 made the thin runner method-aware (POST + GET). That widened the verb surface
 * without proving the verb a human approved is the verb actually sent, so a POST
 * authorization could have settled a GET candidate (or vice versa). This module is
 * the gate that closes that hole:
 *
 *   authorization.method == selected_candidate.method == planned.method == intent method
 *
 * It imports only the neutral method contract (no planner, no probe, no executor), so
 * it can be used by the authorization validator and the thin executor without cycles.
 * It is pure: no key, no wallet, no network, no payment.
 */

import {
  isThinRunnerSettleableMethod,
  normalizeThinSettlementMethod,
  resolveEffectiveThinSettlementMethod,
  THIN_RUNNER_SETTLEABLE_METHODS,
} from "./thin-settlement-method-contract";

/** The authorization carries no method at all — fail closed, never assume POST. */
export const BLOCKED_AUTHORIZATION_METHOD_MISSING = "BLOCKED_AUTHORIZATION_METHOD_MISSING";
/** The authorized method is not settleable by the thin runner. */
export const BLOCKED_AUTHORIZATION_METHOD_UNSUPPORTED = "BLOCKED_AUTHORIZATION_METHOD_UNSUPPORTED";
/** The authorized method disagrees with the selected candidate or the planned request. */
export const BLOCKED_AUTHORIZATION_METHOD_MISMATCH = "BLOCKED_AUTHORIZATION_METHOD_MISMATCH";
/** The method persisted in the pre-payment intent disagrees with the authorized method. */
export const BLOCKED_INTENT_METHOD_MISMATCH = "BLOCKED_INTENT_METHOD_MISMATCH";

/** Auditable record of every method in the chain, for settlement evidence. */
export interface AuthorizationMethodBindingEvidence {
  readonly authorization_method: string | null;
  readonly selected_candidate_method: string | null;
  readonly selected_candidate_effective_method: string;
  readonly planned_method: string | null;
  readonly intent_method: string | null;
  readonly bound_method: string | null;
}

export interface AuthorizationMethodBindingInput {
  readonly authorizationMethod?: string | null;
  readonly candidateMethod?: string | null;
  /** Method the planner resolved; omit when checking authorization vs candidate only. */
  readonly plannedMethod?: string | null;
  /** Method stamped into the pre-payment intent; omit before the intent exists. */
  readonly intentMethod?: string | null;
}

export interface AuthorizationMethodBindingResult {
  readonly bound: boolean;
  readonly reasons: readonly string[];
  readonly evidence: AuthorizationMethodBindingEvidence;
}

/**
 * Checks the method chain. Absent `plannedMethod`/`intentMethod` are treated as "not
 * yet known" and skipped — present-but-different always blocks. The candidate side
 * uses the contract's effective method so a candidate with no declared verb keeps its
 * historical POST meaning, while a candidate that DOES declare one is never overridden.
 */
export function checkAuthorizationMethodBinding(
  input: AuthorizationMethodBindingInput,
): AuthorizationMethodBindingResult {
  const reasons: string[] = [];
  const authorizationMethod = normalizeThinSettlementMethod(input.authorizationMethod);
  const candidateEffective = resolveEffectiveThinSettlementMethod(input.candidateMethod);
  const plannedMethod = normalizeThinSettlementMethod(input.plannedMethod);
  const intentMethod = normalizeThinSettlementMethod(input.intentMethod);

  const evidence: AuthorizationMethodBindingEvidence = {
    authorization_method: authorizationMethod,
    selected_candidate_method: normalizeThinSettlementMethod(input.candidateMethod),
    selected_candidate_effective_method: candidateEffective,
    planned_method: plannedMethod,
    intent_method: intentMethod,
    bound_method: authorizationMethod,
  };

  if (!authorizationMethod) {
    reasons.push(
      `${BLOCKED_AUTHORIZATION_METHOD_MISSING}: authorization must declare method (one of ${THIN_RUNNER_SETTLEABLE_METHODS.join(", ")})`,
    );
    return { bound: false, reasons, evidence };
  }

  if (!isThinRunnerSettleableMethod(authorizationMethod)) {
    reasons.push(
      `${BLOCKED_AUTHORIZATION_METHOD_UNSUPPORTED}: authorized method ${authorizationMethod} not in ${THIN_RUNNER_SETTLEABLE_METHODS.join(", ")}`,
    );
    return { bound: false, reasons, evidence };
  }

  if (authorizationMethod !== candidateEffective) {
    reasons.push(
      `${BLOCKED_AUTHORIZATION_METHOD_MISMATCH}: authorization method ${authorizationMethod} != selected_candidate method ${candidateEffective}`,
    );
  }

  if (plannedMethod && authorizationMethod !== plannedMethod) {
    reasons.push(
      `${BLOCKED_AUTHORIZATION_METHOD_MISMATCH}: authorization method ${authorizationMethod} != planned method ${plannedMethod}`,
    );
  }

  if (intentMethod && authorizationMethod !== intentMethod) {
    reasons.push(
      `${BLOCKED_INTENT_METHOD_MISMATCH}: authorization method ${authorizationMethod} != intent method ${intentMethod}`,
    );
  }

  return { bound: reasons.length === 0, reasons, evidence };
}

/** Throwing form for the pre-payment path: blocks before any payment-bearing work. */
export function assertAuthorizationMethodBinding(
  input: AuthorizationMethodBindingInput,
): AuthorizationMethodBindingEvidence {
  const result = checkAuthorizationMethodBinding(input);
  if (!result.bound) {
    throw new Error(result.reasons.join("; "));
  }
  return result.evidence;
}
