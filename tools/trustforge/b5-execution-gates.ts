/**
 * b5-execution-gates — B.5 productive payment generalization guards.
 *
 * B5 decides what may be worth paying for.
 * B4 executes an exactly authorized payment.
 * Discovery never authorizes payment.
 */

export const GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT =
  "GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT" as const;
export const GUARD_B5_CANNOT_SIGN = "GUARD_B5_CANNOT_SIGN" as const;
export const GUARD_B5_CANNOT_SEND = "GUARD_B5_CANNOT_SEND" as const;
export const GUARD_B5_CANNOT_CREATE_PSA_DIRECTLY =
  "GUARD_B5_CANNOT_CREATE_PSA_DIRECTLY" as const;
export const GUARD_B5_REQUIRES_SELECTED_CANDIDATE =
  "GUARD_B5_REQUIRES_SELECTED_CANDIDATE" as const;
export const GUARD_B5_REQUIRES_HUMAN_DECISION_FOR_REAL_PAYMENT =
  "GUARD_B5_REQUIRES_HUMAN_DECISION_FOR_REAL_PAYMENT" as const;
export const GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL =
  "GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL" as const;
export const GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED =
  "GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED" as const;
export const GUARD_DISCOVERY_REQUIREMENTS_NOT_PAYTIME =
  "GUARD_DISCOVERY_REQUIREMENTS_NOT_PAYTIME" as const;

export const BLOCKED_B5_CANDIDATE_UNSUPPORTED =
  "BLOCKED_B5_CANDIDATE_UNSUPPORTED" as const;
export const BLOCKED_B5_CANDIDATE_INELIGIBLE =
  "BLOCKED_B5_CANDIDATE_INELIGIBLE" as const;
export const BLOCKED_B5_NO_ELIGIBLE_CANDIDATE =
  "BLOCKED_B5_NO_ELIGIBLE_CANDIDATE" as const;
export const BLOCKED_B5_SELECTION_MISSING =
  "BLOCKED_B5_SELECTION_MISSING" as const;
export const BLOCKED_B5_SELECTION_DRIFT =
  "BLOCKED_B5_SELECTION_DRIFT" as const;
export const BLOCKED_B5_EXECUTION_BINDING_MISSING =
  "BLOCKED_B5_EXECUTION_BINDING_MISSING" as const;

export const B5_CANDIDATE_POLICY_SCHEMA =
  "trustforge_b5_candidate_policy.v1" as const;
export const B5_PAYMENT_CANDIDATE_SCHEMA =
  "trustforge_payment_candidate.v1" as const;
export const B5_SELECTION_SCHEMA =
  "trustforge_payment_candidate_selection.v1" as const;
export const B5_LEDGER_SCHEMA =
  "trustforge_payment_candidate_ledger.v1" as const;
