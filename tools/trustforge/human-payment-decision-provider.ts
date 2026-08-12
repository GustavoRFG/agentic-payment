/**
 * human-payment-decision-provider — pluggable payment approval policy.
 *
 * Current operational mode: manual-approve-reject.
 * Payment core remains independent of WinForms.
 */

import {
  B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
  B4_MANUAL_APPROVE_REJECT_POLICY,
  BLOCKED_B4_HUMAN_REJECTED,
  GUARD_HUMAN_REJECT_CANNOT_REACH_SIGNER,
  GUARD_PAYMENT_REQUIRES_EXACT_APPROVAL_ARTIFACTS,
} from "./b4-execution-gates";

export {
  B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
  B4_MANUAL_APPROVE_REJECT_POLICY,
};

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

export type HumanPaymentDecisionOutcome =
  | {
      readonly decision: "APPROVE";
      readonly human_decision_id: string;
      readonly decided_at: string;
      readonly provider_id: string;
      readonly policy: typeof B4_MANUAL_APPROVE_REJECT_POLICY;
    }
  | {
      readonly decision: "REJECT";
      readonly human_decision_id: string;
      readonly decided_at: string;
      readonly provider_id: string;
      readonly policy: typeof B4_MANUAL_APPROVE_REJECT_POLICY;
      readonly reason: "rejected" | "closed";
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

/** Injected adapter for tests — no GUI. */
export function createInjectedHumanPaymentDecisionProvider(
  outcome: HumanPaymentDecisionOutcome | (() => HumanPaymentDecisionOutcome),
): HumanPaymentDecisionProvider {
  let used = false;
  return {
    providerId: "injected-test-decision",
    policy: B4_MANUAL_APPROVE_REJECT_POLICY,
    async decideOnce() {
      if (used) {
        throw new Error("injected decision provider is one-shot");
      }
      used = true;
      return typeof outcome === "function" ? outcome() : outcome;
    },
  };
}
