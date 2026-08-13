/**
 * b5-selected-candidate-bridge — B5 selection → B4 DiscoveredSelectedCandidate.
 *
 * B5 cannot sign/send/create PSA. It only hands a normalized selected candidate
 * into the Thin Mainnet Runner.
 */

import {
  BLOCKED_B5_EXECUTION_BINDING_MISSING,
  BLOCKED_B5_SELECTION_DRIFT,
  BLOCKED_B5_SELECTION_MISSING,
  GUARD_B5_CANNOT_CREATE_PSA_DIRECTLY,
  GUARD_B5_CANNOT_SEND,
  GUARD_B5_CANNOT_SIGN,
  GUARD_B5_REQUIRES_HUMAN_DECISION_FOR_REAL_PAYMENT,
  GUARD_B5_REQUIRES_SELECTED_CANDIDATE,
  GUARD_DISCOVERY_REQUIREMENTS_NOT_PAYTIME,
  GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL,
} from "./b5-execution-gates";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import type { PaymentCandidateSelection } from "./payment-candidate-selection";
import { paymentCandidateIdentitySha256, buildPaymentCandidateIdentityTuple, bodyDigestFromValue } from "./payment-candidate-v1";
import { normalizeFromDiscoveredSelectedCandidate } from "./payment-candidate-normalize";

export function assertB5CannotTouchPaymentCore(): void {
  void GUARD_B5_CANNOT_SIGN;
  void GUARD_B5_CANNOT_SEND;
  void GUARD_B5_CANNOT_CREATE_PSA_DIRECTLY;
  void GUARD_B5_REQUIRES_HUMAN_DECISION_FOR_REAL_PAYMENT;
}

export function selectedPaymentCandidateToDiscovered(
  selection: PaymentCandidateSelection,
): DiscoveredSelectedCandidate {
  void GUARD_B5_REQUIRES_SELECTED_CANDIDATE;
  void GUARD_DISCOVERY_REQUIREMENTS_NOT_PAYTIME;
  assertB5CannotTouchPaymentCore();
  if (!selection || selection.payment_authorized !== false) {
    throw new Error(`${BLOCKED_B5_SELECTION_MISSING}: invalid selection authority flag`);
  }
  const exec = selection.selected_candidate.execution_selected_candidate;
  if (!exec) {
    throw new Error(
      `${BLOCKED_B5_EXECUTION_BINDING_MISSING}: selected candidate lacks B4 handoff payload`,
    );
  }
  assertSelectionMatchesExecutionBinding(selection, exec);
  return exec;
}

export function assertSelectionMatchesExecutionBinding(
  selection: PaymentCandidateSelection,
  exec: DiscoveredSelectedCandidate,
): void {
  void GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL;
  const renorm = normalizeFromDiscoveredSelectedCandidate(exec, {
    discovered_at: selection.selected_candidate.discovered_at,
    discovery_source: selection.selected_candidate.discovery_source,
  });
  if (renorm.candidate_id !== selection.selected_candidate_id) {
    throw new Error(
      `${BLOCKED_B5_SELECTION_DRIFT}: execution binding candidate_id drift`,
    );
  }
  const body_digest = bodyDigestFromValue(exec.request_body);
  const id = paymentCandidateIdentitySha256(
    buildPaymentCandidateIdentityTuple({
      provider_id: exec.provider,
      service_id: exec.service_id,
      endpoint: exec.endpoint,
      method: exec.method ?? "GET",
      query: exec.request_query.map(([k, v]) => [k, v] as const),
      body_digest,
      network_canonical: exec.canonical_network_caip2,
      asset: exec.asset,
      pay_to: exec.authorized_pay_to,
      amount_atomic: exec.quote_atomic,
      protocol: "x402",
      protocol_version: String(exec.protocol_version),
      scheme: exec.scheme,
    }),
  );
  if (id !== selection.selected_candidate_id) {
    throw new Error(
      `${BLOCKED_B5_SELECTION_DRIFT}: identity tuple mismatch vs selection`,
    );
  }
}
