/**
 * payment-candidate-human-view — approval presentation from B.5 selection.
 */

import type { PaymentApprovalCandidateView } from "./human-payment-decision-provider";
import type { PaymentCandidateSelection } from "./payment-candidate-selection";
import {
  GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL,
} from "./b5-execution-gates";

export interface B5HumanApprovalPresentation {
  readonly schema_version: "trustforge_b5_human_approval_presentation.v1";
  readonly service: string;
  readonly purpose: string;
  readonly network: string;
  readonly amount: string;
  readonly asset: string;
  readonly seller: string;
  readonly request: string;
  readonly why_selected: readonly string[];
  readonly risks: readonly string[];
  readonly selection_id: string;
  readonly candidate_id: string;
  readonly payment_authorized: false;
  readonly approval_view: PaymentApprovalCandidateView;
}

export function buildB5HumanApprovalPresentation(
  selection: PaymentCandidateSelection,
  buyerWallet: string,
): B5HumanApprovalPresentation {
  void GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL;
  const c = selection.selected_candidate;
  const amount =
    typeof c.amount_display === "string" && c.amount_display !== "unknown"
      ? c.amount_display
      : String(c.amount_atomic);
  const network =
    typeof c.network_canonical === "string" ? c.network_canonical : "unknown";
  const assetSymbol =
    typeof c.asset_symbol === "string" && c.asset_symbol !== "unknown"
      ? c.asset_symbol
      : "USDC";
  const seller = typeof c.pay_to === "string" ? c.pay_to : "unknown";
  const purpose =
    typeof c.expected_utility.purpose === "string"
      ? c.expected_utility.purpose
      : "unknown";
  const query = c.query.map(([k, v]) => `${k}=${v}`).join("&");
  const request = `${c.method} ${c.endpoint}${query ? `?${query}` : ""}`;

  return {
    schema_version: "trustforge_b5_human_approval_presentation.v1",
    service: c.service_label,
    purpose,
    network,
    amount: `${amount} ${assetSymbol}`,
    asset: typeof c.asset === "string" ? c.asset : "unknown",
    seller,
    request,
    why_selected: selection.selection_rationale,
    risks: selection.selected_economic_assessment.risk_flags,
    selection_id: selection.selection_id,
    candidate_id: selection.selected_candidate_id,
    payment_authorized: false,
    approval_view: {
      service_label: `${c.service_label} | ${purpose}`,
      network_label: network,
      buyer: buyerWallet,
      seller,
      amount_usdc: amount,
      amount_atomic:
        typeof c.amount_atomic === "string" ? c.amount_atomic : "0",
      request_summary: request,
      endpoint: c.endpoint,
      method: c.method === "unknown" ? "GET" : c.method,
      max_attempts: 1,
      max_signatures: 1,
      max_payment_requests: 1,
      allow_retry: false,
      allow_resend: false,
    },
  };
}
