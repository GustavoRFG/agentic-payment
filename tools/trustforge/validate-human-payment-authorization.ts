/**
 * validate-human-payment-authorization — Phase 6 paid probe gate validator.
 */

import { compareUsdcDecimal, parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import { MAINNET_NETWORK, TESTNET_NETWORK } from "../../shared/payment-safety";
import { MAINNET_BUYER_WALLET, SEPOLIA_TESTNET_BUYER_WALLET } from "./network-config";
import { checkAuthorizationMethodBinding } from "./authorization-method-binding";
import {
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING,
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH,
  createThinSettlementRequestBinding,
  type CanonicalJsonValue,
  type CanonicalQuery,
  type ThinSettlementRequestSummary,
} from "./thin-settlement-request-binding";
import {
  BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH,
  BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
  HUMAN_AUTHORIZATION_MAX_TTL_SECONDS,
  REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED,
  SIGNED_BUT_NOT_SENT_POLICY,
  validatePersistedSellerRequirementsObservation,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";
export {
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING,
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH,
} from "./thin-settlement-request-binding";

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
  /**
   * HTTP method the human authorized. Required: it must equal the selected candidate's
   * method, the planned method, and the intent method before any payment.
   */
  readonly method?: string | null;
  readonly request_binding_sha256?: string | null;
  readonly request_summary?: ThinSettlementRequestSummary | null;
  readonly canonical_requirements_sha256?: string | null;
  readonly canonical_envelope_sha256?: string | null;
  readonly x402_version?: 1 | 2 | null;
  readonly scheme?: string | null;
  readonly seller_network_raw?: string | null;
  readonly canonical_network_caip2?: string | null;
  /** Operational alias, required to equal canonical_network_caip2. */
  readonly network?: string;
  readonly asset?: string;
  readonly pay_to?: string | null;
  readonly amount_atomic?: string | null;
  readonly maximum_authorized_amount_atomic?: string | null;
  readonly buyer_wallet?: string;
  readonly max_usdc: string;
  readonly max_payment_attempts: number;
  readonly allow_retry: boolean;
  readonly allow_wallet_load?: boolean;
  readonly allow_payment_header?: boolean;
  readonly require_dedicated_wallet?: boolean;
  readonly decided_at?: string | null;
  readonly authorization_ttl_seconds?: number | null;
  readonly authorization_expires_at?: string | null;
  readonly buyer_nonce_policy?: string | null;
  readonly buyer_validity_policy?: {
    readonly valid_after_clock_skew_seconds?: number;
    readonly valid_before_must_not_exceed?: string;
    readonly signed_but_not_sent?: string;
  } | null;
  readonly requirements_refresh_policy?: string | null;
  readonly rationale?: string;
  readonly target_selection_audit?: TargetSelectionAuditMetadata | null;
}

export interface SelectedCandidateRef {
  readonly schema_version?: string;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly method?: string | null;
  readonly request_input_status?: "known";
  readonly request_query?: CanonicalQuery;
  readonly request_body?: CanonicalJsonValue | null;
  readonly request_binding_sha256?: string | null;
  readonly seller_requirements?: SellerRequirementsObservation | null;
  readonly quote_amount_usdc?: string;
  readonly recommended_max_usdc?: string;
  readonly seller_network_raw?: string;
  readonly canonical_network_caip2?: string;
  readonly network?: string;
  readonly asset?: string;
  readonly buyer_wallet?: string;
  readonly target_selection_audit?: TargetSelectionAuditMetadata | null;
}

function validateRequestBinding(
  auth: HumanPaymentAuthorization,
  selected: SelectedCandidateRef,
  reasons: string[],
): void {
  const authorizedHash = auth.request_binding_sha256?.trim().toLowerCase();
  if (!authorizedHash) {
    reasons.push(`${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING}: authorization hash absent`);
  }
  if (
    selected.request_input_status !== "known" ||
    !Array.isArray(selected.request_query) ||
    !Object.prototype.hasOwnProperty.call(selected, "request_body") ||
    !selected.request_binding_sha256
  ) {
    reasons.push("REJECTED_REQUEST_BINDING_NOT_PERSISTED: selected_candidate request shape absent");
    return;
  }
  try {
    const binding = createThinSettlementRequestBinding({
      endpoint: selected.endpoint,
      method: String(selected.method ?? ""),
      input_status: "known",
      query: selected.request_query,
      body: selected.request_body,
    });
    if (binding.binding_sha256 !== selected.request_binding_sha256.toLowerCase()) {
      reasons.push("BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH: selected_candidate hash is not canonical");
      return;
    }
    if (authorizedHash && authorizedHash !== binding.binding_sha256) {
      reasons.push(
        `${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH}: authorization differs from selected_candidate`,
      );
    }
    if (!auth.request_summary) {
      reasons.push(`${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING}: request_summary absent`);
    } else {
      try {
        const summaryBinding = createThinSettlementRequestBinding({
          endpoint: auth.request_summary.endpoint,
          method: auth.request_summary.method,
          input_status: "known",
          query: auth.request_summary.query,
          body: auth.request_summary.body,
        });
        if (summaryBinding.binding_sha256 !== binding.binding_sha256) {
          reasons.push(
            `${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH}: request_summary differs from selected_candidate`,
          );
        }
      } catch (error) {
        reasons.push(
          `${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH}: invalid request_summary: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  } catch (error) {
    reasons.push(error instanceof Error ? error.message : String(error));
  }
}

function validateSellerRequirementsAuthorization(
  auth: HumanPaymentAuthorization,
  selected: SelectedCandidateRef,
  reasons: string[],
): void {
  if (selected.schema_version !== "trustforge_selected_candidate.v3" || !selected.seller_requirements) {
    reasons.push(
      `${REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED}: selected_candidate seller requirements absent`,
    );
    return;
  }
  const requestHash = selected.request_binding_sha256?.trim().toLowerCase() ?? "";
  const persisted = validatePersistedSellerRequirementsObservation(
    selected.seller_requirements,
    requestHash,
  );
  reasons.push(...persisted.reasons);
  if (!persisted.valid) return;
  const binding = selected.seller_requirements.binding;
  if (!auth.canonical_requirements_sha256) {
    reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: authorization requirements hash absent`);
  } else if (auth.canonical_requirements_sha256 !== binding.canonical_requirements_sha256) {
    reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: authorization requirements hash mismatch`);
  }
  if (!auth.canonical_envelope_sha256) {
    reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: authorization envelope hash absent`);
  } else if (auth.canonical_envelope_sha256 !== binding.canonical_envelope_sha256) {
    reasons.push(`${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: authorization envelope hash mismatch`);
  }
  if (auth.x402_version !== binding.protocol_version) reasons.push("x402_version mismatch vs selected_candidate");
  if (auth.scheme !== binding.scheme) reasons.push("scheme mismatch vs selected_candidate");
  if (auth.seller_network_raw !== binding.seller_network_raw) {
    reasons.push("seller_network_raw mismatch vs seller requirements");
  }
  if (auth.canonical_network_caip2 !== binding.canonical_network_caip2) {
    reasons.push("canonical_network_caip2 mismatch vs seller requirements");
  }
  if (auth.network !== binding.canonical_network_caip2) {
    reasons.push("operational network mismatch vs seller requirements canonical network");
  }
  if (auth.asset?.toLowerCase() !== binding.asset.toLowerCase()) {
    reasons.push("asset mismatch vs seller requirements");
  }
  if (auth.pay_to?.toLowerCase() !== binding.pay_to.toLowerCase()) {
    reasons.push("pay_to mismatch vs seller requirements");
  }
  if (auth.amount_atomic !== binding.amount_atomic) {
    reasons.push("amount_atomic mismatch vs seller requirements");
  }
  let maxAtomic: string | null = null;
  try {
    maxAtomic = parseUsdcDecimalToAtomic(auth.max_usdc).toString();
  } catch {
    // Existing max_usdc validation reports the primary error.
  }
  if (maxAtomic && auth.maximum_authorized_amount_atomic !== maxAtomic) {
    reasons.push("maximum_authorized_amount_atomic mismatch vs max_usdc");
  }
  if (maxAtomic && BigInt(maxAtomic) < BigInt(binding.amount_atomic)) {
    reasons.push("maximum authorized amount is below seller amount");
  }
  if (auth.buyer_nonce_policy !== "cryptographic_random_32_bytes_per_attempt") {
    reasons.push("buyer_nonce_policy must require cryptographic random 32 bytes per attempt");
  }
  if (
    auth.buyer_validity_policy?.valid_after_clock_skew_seconds !==
    BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS
  ) {
    reasons.push(`buyer validAfter clock skew must be ${BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS}s`);
  }
  if (auth.buyer_validity_policy?.valid_before_must_not_exceed !== "effective_signing_deadline") {
    reasons.push("buyer validBefore must not exceed effective_signing_deadline");
  }
  if (auth.buyer_validity_policy?.signed_but_not_sent !== SIGNED_BUT_NOT_SENT_POLICY) {
    reasons.push(`signed-but-not-sent policy must be ${SIGNED_BUT_NOT_SENT_POLICY}`);
  }
  if (auth.requirements_refresh_policy !== "exact_hash_match_before_signing") {
    reasons.push("requirements_refresh_policy must be exact_hash_match_before_signing");
  }
  for (const buyerOwnedField of [
    "nonce",
    "signature",
    "validAfter",
    "validBefore",
    "paymentPayload",
    "buyer_signed_authorization",
  ]) {
    if (Object.prototype.hasOwnProperty.call(auth, buyerOwnedField)) {
      reasons.push(`human authorization must not contain buyer field ${buyerOwnedField}`);
    }
  }
}

function validateAuthorizationExpiry(
  auth: HumanPaymentAuthorization,
  reasons: string[],
): void {
  const decidedMs = Date.parse(auth.decided_at ?? "");
  const expiresMs = Date.parse(auth.authorization_expires_at ?? "");
  if (!Number.isFinite(decidedMs)) {
    reasons.push("decided_at is required and must be valid");
    return;
  }
  if (!Number.isFinite(expiresMs)) {
    reasons.push("authorization_expires_at is required and must be valid");
    return;
  }
  const ttlSeconds = (expiresMs - decidedMs) / 1000;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    reasons.push("authorization TTL must be a positive integer number of seconds");
  }
  if (ttlSeconds > HUMAN_AUTHORIZATION_MAX_TTL_SECONDS) {
    reasons.push(`authorization TTL must not exceed ${HUMAN_AUTHORIZATION_MAX_TTL_SECONDS} seconds`);
  }
  if (auth.authorization_ttl_seconds !== ttlSeconds) {
    reasons.push("authorization_ttl_seconds mismatch vs decided_at/expires_at");
  }
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

  if (auth.authorization_schema_version !== "trustforge_paid_probe_authorization.v3") {
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
  // Pre-live method binding: an authorization for one verb must never settle another.
  reasons.push(
    ...checkAuthorizationMethodBinding({
      authorizationMethod: auth.method,
      candidateMethod: selected.method,
    }).reasons,
  );
  validateRequestBinding(auth, selected, reasons);
  validateSellerRequirementsAuthorization(auth, selected, reasons);
  if (
    selected.seller_network_raw !== selected.seller_requirements?.binding.seller_network_raw ||
    selected.canonical_network_caip2 !==
      selected.seller_requirements?.binding.canonical_network_caip2
  ) {
    reasons.push("selected_candidate network identity mismatch vs seller requirements");
  }
  if (selected.network !== selected.canonical_network_caip2) {
    reasons.push("selected_candidate operational network must equal canonical_network_caip2");
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
  validateAuthorizationExpiry(auth, reasons);
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
