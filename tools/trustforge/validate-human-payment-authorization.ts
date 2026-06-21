/**
 * validate-human-payment-authorization — Phase 6 paid probe gate validator.
 */

import { compareUsdcDecimal } from "./external-x402-get-policy";
import { MAINNET_NETWORK, TESTNET_NETWORK } from "../../shared/payment-safety";
import { MAINNET_BUYER_WALLET, SEPOLIA_TESTNET_BUYER_WALLET } from "./network-config";

export interface TargetSelectionAuditMetadata {
  readonly selected_resource_url: string;
  readonly handshake_status: string;
  readonly fallback_resource_urls: readonly string[];
  readonly scoring_rationale: readonly string[];
}

export interface HumanPaymentAuthorization {
  readonly authorization_schema_version: string;
  readonly decision: string;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly network?: string;
  readonly asset?: string;
  readonly buyer_wallet?: string;
  readonly max_usdc: string;
  readonly max_payment_attempts: number;
  readonly allow_retry: boolean;
  readonly allow_wallet_load?: boolean;
  readonly allow_payment_header?: boolean;
  readonly require_dedicated_wallet?: boolean;
  readonly decided_at?: string | null;
  readonly rationale?: string;
  readonly target_selection_audit?: TargetSelectionAuditMetadata | null;
}

export interface SelectedCandidateRef {
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly quote_amount_usdc?: string;
  readonly recommended_max_usdc?: string;
  readonly network?: string;
  readonly asset?: string;
  readonly buyer_wallet?: string;
  readonly target_selection_audit?: TargetSelectionAuditMetadata | null;
}

function validateTargetSelectionAudit(
  audit: TargetSelectionAuditMetadata | null | undefined,
  selected: SelectedCandidateRef,
  label: string,
  reasons: string[],
): void {
  if (!audit) return;
  if (audit.selected_resource_url !== selected.endpoint) {
    reasons.push(`${label} selected_resource_url mismatch vs selected_candidate`);
  }
  if (!audit.handshake_status?.trim()) {
    reasons.push(`${label} handshake_status is required`);
  }
  if (!Array.isArray(audit.fallback_resource_urls)) {
    reasons.push(`${label} fallback_resource_urls must be an array`);
  }
  if (!Array.isArray(audit.scoring_rationale) || audit.scoring_rationale.length === 0) {
    reasons.push(`${label} scoring_rationale is required`);
  }
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
  if (auth.network && selected.network && auth.network !== selected.network) {
    reasons.push("network mismatch vs selected_candidate");
  }
  if (selected.network === TESTNET_NETWORK) {
    if (auth.network !== TESTNET_NETWORK) {
      reasons.push(`testnet authorization requires network ${TESTNET_NETWORK}`);
    }
    if (auth.network === MAINNET_NETWORK) {
      reasons.push("mainnet network refused for testnet authorization");
    }
    const buyer = auth.buyer_wallet ?? selected.buyer_wallet;
    if (buyer?.toLowerCase() !== SEPOLIA_TESTNET_BUYER_WALLET.toLowerCase()) {
      reasons.push("testnet authorization buyer_wallet must be Sepolia test wallet");
    }
    if (buyer?.toLowerCase() === MAINNET_BUYER_WALLET.toLowerCase()) {
      reasons.push("mainnet buyer wallet refused for testnet authorization");
    }
  }
  if (!auth.decided_at) {
    reasons.push("decided_at is required");
  }
  if (!auth.rationale?.trim()) {
    reasons.push("rationale is required");
  }
  validateTargetSelectionAudit(
    selected.target_selection_audit,
    selected,
    "selected_candidate target_selection_audit",
    reasons,
  );
  validateTargetSelectionAudit(
    auth.target_selection_audit,
    selected,
    "authorization target_selection_audit",
    reasons,
  );
  if (
    auth.target_selection_audit &&
    selected.target_selection_audit &&
    JSON.stringify(auth.target_selection_audit) !== JSON.stringify(selected.target_selection_audit)
  ) {
    reasons.push("authorization target_selection_audit mismatch vs selected_candidate");
  }

  return { valid: reasons.length === 0, reasons };
}
