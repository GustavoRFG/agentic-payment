/**
 * human-payment-decision-provider — pluggable payment approval policy.
 *
 * B.4.1: only explicit Approve/Reject button activation may produce APPROVE/REJECT.
 * Window close / Esc / UI failure → ABORT / UI_FAILED (never REJECT).
 */

import {
  B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
  B4_MANUAL_APPROVE_REJECT_POLICY,
  BLOCKED_B4_HUMAN_REJECTED,
  GUARD_HUMAN_REJECT_CANNOT_REACH_SIGNER,
  GUARD_ONLY_EXPLICIT_BUTTON_PRODUCES_REJECT,
  GUARD_PAYMENT_REQUIRES_EXACT_APPROVAL_ARTIFACTS,
  GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT,
} from "./b4-execution-gates";

export {
  B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
  B4_MANUAL_APPROVE_REJECT_POLICY,
};

export type HumanPaymentDecisionKind = "APPROVE" | "REJECT" | "ABORT" | "UI_FAILED";

export type HumanPaymentDecisionSource =
  | "approve_button"
  | "reject_button"
  | "window_close"
  | "keyboard_close"
  | "ui_failure";

export interface PaymentApprovalCandidateView {
  readonly service_label: string;
  readonly network_label: string;
  readonly buyer: string;
  readonly seller: string;
  readonly amount_usdc: string;
  readonly amount_atomic: string;
  readonly request_summary: string;
  readonly endpoint: string;
  readonly method: string;
  readonly max_attempts: 1;
  readonly max_signatures: 1;
  readonly max_payment_requests: 1;
  readonly allow_retry: false;
  readonly allow_resend: false;
}

export interface HumanPaymentDecisionProvenance {
  readonly decision: HumanPaymentDecisionKind;
  readonly decision_source: HumanPaymentDecisionSource;
  /** true only for approve_button or reject_button */
  readonly explicit_human_decision: boolean;
}

export type HumanPaymentDecisionOutcome = HumanPaymentDecisionProvenance & {
  readonly human_decision_id: string;
  readonly decided_at: string;
  readonly provider_id: string;
  readonly policy: typeof B4_MANUAL_APPROVE_REJECT_POLICY;
};

export interface HumanPaymentDecisionProvider {
  readonly providerId: string;
  readonly policy: typeof B4_MANUAL_APPROVE_REJECT_POLICY;
  decideOnce(
    candidate: PaymentApprovalCandidateView,
  ): Promise<HumanPaymentDecisionOutcome>;
}

export function assertApprovalArtifactsRequired(): never {
  throw new Error(
    `${GUARD_PAYMENT_REQUIRES_EXACT_APPROVAL_ARTIFACTS}: APPROVE must yield exact signing+send mandates, not authorized=true`,
  );
}

export function assertHumanRejectCannotReachSigner(): never {
  throw new Error(
    `${GUARD_HUMAN_REJECT_CANNOT_REACH_SIGNER}: ${BLOCKED_B4_HUMAN_REJECTED}`,
  );
}

export function assertOnlyExplicitButtonProducesReject(source: HumanPaymentDecisionSource): void {
  void GUARD_ONLY_EXPLICIT_BUTTON_PRODUCES_REJECT;
  if (source !== "reject_button") {
    throw new Error(
      `${GUARD_ONLY_EXPLICIT_BUTTON_PRODUCES_REJECT}: REJECT requires reject_button, got ${source}`,
    );
  }
}

export function assertWindowCloseIsAbortNotReject(
  decision: HumanPaymentDecisionKind,
  source: HumanPaymentDecisionSource,
): void {
  void GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT;
  if (
    (source === "window_close" || source === "keyboard_close") &&
    decision === "REJECT"
  ) {
    throw new Error(
      `${GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT}: window/keyboard close must be ABORT, not REJECT`,
    );
  }
}

export function buildDecisionOutcome(input: {
  readonly decision: HumanPaymentDecisionKind;
  readonly decision_source: HumanPaymentDecisionSource;
  readonly human_decision_id: string;
  readonly decided_at: string;
  readonly provider_id: string;
}): HumanPaymentDecisionOutcome {
  const explicit =
    input.decision_source === "approve_button" ||
    input.decision_source === "reject_button";
  if (input.decision === "APPROVE" && input.decision_source !== "approve_button") {
    throw new Error("APPROVE requires approve_button source");
  }
  if (input.decision === "REJECT") {
    assertOnlyExplicitButtonProducesReject(input.decision_source);
  }
  assertWindowCloseIsAbortNotReject(input.decision, input.decision_source);
  return {
    decision: input.decision,
    decision_source: input.decision_source,
    explicit_human_decision: explicit,
    human_decision_id: input.human_decision_id,
    decided_at: input.decided_at,
    provider_id: input.provider_id,
    policy: B4_MANUAL_APPROVE_REJECT_POLICY,
  };
}

export const TEST_HUMAN_PAYMENT_DECISION_PROVIDER_ID =
  "test-human-payment-decision" as const;

/**
 * TestHumanPaymentDecisionProvider — headless / in-memory only.
 * NEVER spawns WinForms, PowerShell UI, mouse, SendKeys, or UI Automation.
 * TEST DECISION != HUMAN DECISION.
 */
export function createTestHumanPaymentDecisionProvider(
  outcome: HumanPaymentDecisionOutcome | (() => HumanPaymentDecisionOutcome),
): HumanPaymentDecisionProvider {
  let used = false;
  return {
    providerId: TEST_HUMAN_PAYMENT_DECISION_PROVIDER_ID,
    policy: B4_MANUAL_APPROVE_REJECT_POLICY,
    async decideOnce() {
      if (used) {
        throw new Error("test decision provider is one-shot");
      }
      used = true;
      return typeof outcome === "function" ? outcome() : outcome;
    },
  };
}

/** @deprecated Use createTestHumanPaymentDecisionProvider */
export function createInjectedHumanPaymentDecisionProvider(
  outcome: HumanPaymentDecisionOutcome | (() => HumanPaymentDecisionOutcome),
): HumanPaymentDecisionProvider {
  return createTestHumanPaymentDecisionProvider(outcome);
}
