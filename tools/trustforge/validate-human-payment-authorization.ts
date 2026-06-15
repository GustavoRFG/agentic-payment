/**
 * validate-human-payment-authorization — Phase 6 paid probe gate validator.
 */

import { compareUsdcDecimal } from "./external-x402-get-policy";

export interface HumanPaymentAuthorization {
  readonly authorization_schema_version: string;
  readonly decision: string;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly max_usdc: string;
  readonly max_payment_attempts: number;
  readonly allow_retry: boolean;
  readonly allow_wallet_load?: boolean;
  readonly allow_payment_header?: boolean;
  readonly require_dedicated_wallet?: boolean;
  readonly decided_at?: string | null;
  readonly rationale?: string;
}

export interface SelectedCandidateRef {
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly quote_amount_usdc?: string;
  readonly recommended_max_usdc?: string;
}

export function validateHumanPaymentAuthorization(
  auth: HumanPaymentAuthorization,
  selected: SelectedCandidateRef,
): { readonly valid: boolean; readonly reasons: readonly string[] } {
  const reasons: string[] = [];

  if (auth.authorization_schema_version !== "trustforge_paid_probe_authorization.v1") {
    reasons.push("invalid authorization_schema_version");
  }
  if (auth.decision !== "authorize_one_payment") {
    reasons.push(`decision must be authorize_one_payment, got ${auth.decision}`);
  }
  if (auth.decision === "reject") {
    reasons.push("human rejected paid probe");
  }
  if (auth.max_payment_attempts !== 1) {
    reasons.push("max_payment_attempts must be 1");
  }
  if (auth.allow_retry !== false) {
    reasons.push("allow_retry must be false");
  }
  if (auth.require_dedicated_wallet === false) {
    reasons.push("require_dedicated_wallet must be true");
  }
  if (!auth.max_usdc || compareUsdcDecimal(auth.max_usdc, "0") <= 0) {
    reasons.push("max_usdc must be > 0");
  }
  if (auth.provider !== selected.provider) {
    reasons.push("provider mismatch vs selected_candidate");
  }
  if (auth.service_id !== selected.service_id) {
    reasons.push("service_id mismatch vs selected_candidate");
  }
  if (auth.endpoint !== selected.endpoint) {
    reasons.push("endpoint mismatch vs selected_candidate");
  }
  if (!auth.decided_at) {
    reasons.push("decided_at is required");
  }
  if (!auth.rationale?.trim()) {
    reasons.push("rationale is required");
  }

  return { valid: reasons.length === 0, reasons };
}
