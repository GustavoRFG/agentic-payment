/**
 * buyer-conditional-payment-send-mandate — parent human authorization for
 * conditional one-shot payment-bearing SEND after exact JIT derivation.
 *
 * Distinct from HumanConditionalCredentialSigningMandate.
 * Never reaches the network; never authorizes credential access or signing.
 * Synthetic builders only in this phase.
 */

import {
  BLOCKED_B37_SEND_MANDATE_EXPIRED,
  BLOCKED_B37_SEND_MANDATE_INVALID,
  BLOCKED_B37_SEND_MANDATE_MISSING,
  GUARD_HUMAN_SEND_MANDATE_CANNOT_DIRECTLY_REACH_NETWORK,
  GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_CREDENTIAL_ACCESS,
  GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_SIGNING,
} from "./b37-execution-gates";
import { REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED } from "./buyer-conditional-credential-signing-mandate";
import type { CanonicalQueryPairs } from "./buyer-conditional-credential-signing-mandate";
import { mandateAddressesEqual } from "./buyer-conditional-credential-signing-mandate";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export { REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED, mandateAddressesEqual };
export type { CanonicalQueryPairs };

export const HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_SCHEMA_VERSION =
  "trustforge_human_conditional_payment_send_mandate.v1" as const;

export const HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_DECISION =
  "authorize_one_shot_conditional_payment_send_derivation" as const;

export const SETTLEMENT_SCOPE_SAME_EXACT_PAYMENT_FLOW =
  "SAME_EXACT_PAYMENT_FLOW_ONLY" as const;

export interface HumanConditionalPaymentSendMandate {
  readonly schema_version: typeof HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_SCHEMA_VERSION;
  readonly decision: typeof HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_DECISION;
  readonly decision_id: string;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly method: string;
  readonly request_query: CanonicalQueryPairs;
  readonly request_body: unknown | null;
  readonly request_binding_sha256: string;
  readonly x402_version: number;
  readonly scheme: string;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  readonly chain_id: number;
  readonly asset: string;
  readonly pay_to: string;
  readonly buyer_wallet: string;
  readonly amount_atomic: string;
  readonly maximum_authorized_amount_atomic: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  /** Conditional privilege — still requires derived PaymentSendAuthorization. */
  readonly payment_bearing_send_conditionally_authorized: true;
  readonly max_payment_bearing_requests: 1;
  readonly max_settlement_attempts: 1;
  readonly settlement_scope: typeof SETTLEMENT_SCOPE_SAME_EXACT_PAYMENT_FLOW;
  readonly allow_retry: false;
  readonly allow_resend: false;
  readonly allow_alternate_seller: false;
  readonly allow_alternate_pay_to: false;
  readonly allow_alternate_asset: false;
  readonly allow_alternate_amount: false;
  /** Explicit negatives — send mandate never authorizes signing/credentials. */
  readonly credential_access_authorized: false;
  readonly real_signing_authorized: false;
  readonly requirements_change_policy: typeof REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED;
  readonly decided_at: string;
  readonly mandate_expires_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, `${label} is required`);
  }
  return value;
}

function requireAtomicAmount(value: unknown, label: string): string {
  const s = requireNonEmptyString(value, label);
  if (!/^[0-9]+$/.test(s) || BigInt(s) <= 0n) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, `${label} must be a positive integer string`);
  }
  return s;
}

export function isHumanConditionalPaymentSendMandate(
  value: unknown,
): value is HumanConditionalPaymentSendMandate {
  return (
    isRecord(value) &&
    value.schema_version === HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_SCHEMA_VERSION
  );
}

export function assertNotHumanSendMandateForNetwork(value: unknown): void {
  if (isHumanConditionalPaymentSendMandate(value)) {
    fail(
      GUARD_HUMAN_SEND_MANDATE_CANNOT_DIRECTLY_REACH_NETWORK,
      "HumanConditionalPaymentSendMandate cannot reach the network; only a derived PaymentSendAuthorization may authorize a payment-bearing request",
    );
  }
}

export function assertNotHumanSendMandateForSigner(value: unknown): void {
  if (isHumanConditionalPaymentSendMandate(value)) {
    fail(
      GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_SIGNING,
      "HumanConditionalPaymentSendMandate cannot authorize signing",
    );
  }
}

export function assertNotHumanSendMandateForCredential(value: unknown): void {
  if (isHumanConditionalPaymentSendMandate(value)) {
    fail(
      GUARD_SEND_MANDATE_CANNOT_AUTHORIZE_CREDENTIAL_ACCESS,
      "HumanConditionalPaymentSendMandate cannot authorize credential access",
    );
  }
}

export function humanConditionalPaymentSendMandateSha256(
  mandate: HumanConditionalPaymentSendMandate,
): string {
  return canonicalJsonSha256(mandate);
}

export function validateHumanConditionalPaymentSendMandate(input: {
  readonly mandate: HumanConditionalPaymentSendMandate | null | undefined;
  readonly now: Date;
}): HumanConditionalPaymentSendMandate {
  const mandate = input.mandate;
  if (!mandate || !isRecord(mandate as unknown)) {
    fail(BLOCKED_B37_SEND_MANDATE_MISSING, "human conditional payment send mandate is required");
  }
  if (mandate.schema_version !== HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_SCHEMA_VERSION) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "unsupported schema_version");
  }
  if (mandate.decision !== HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_DECISION) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "unsupported decision");
  }
  requireNonEmptyString(mandate.decision_id, "decision_id");
  requireNonEmptyString(mandate.provider, "provider");
  requireNonEmptyString(mandate.service_id, "service_id");
  requireNonEmptyString(mandate.endpoint, "endpoint");
  requireNonEmptyString(mandate.method, "method");
  if (!Array.isArray(mandate.request_query)) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "request_query must be an array of pairs");
  }
  requireNonEmptyString(mandate.request_binding_sha256, "request_binding_sha256");
  if (typeof mandate.x402_version !== "number" || !Number.isInteger(mandate.x402_version)) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "x402_version must be an integer");
  }
  requireNonEmptyString(mandate.scheme, "scheme");
  requireNonEmptyString(mandate.seller_network_raw, "seller_network_raw");
  requireNonEmptyString(mandate.canonical_network_caip2, "canonical_network_caip2");
  if (typeof mandate.chain_id !== "number" || mandate.chain_id !== 8453) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "chain_id must be 8453 for Base mainnet canary");
  }
  const amount = requireAtomicAmount(mandate.amount_atomic, "amount_atomic");
  const maximum = requireAtomicAmount(
    mandate.maximum_authorized_amount_atomic,
    "maximum_authorized_amount_atomic",
  );
  if (BigInt(amount) > BigInt(maximum)) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "amount exceeds maximum");
  }
  requireNonEmptyString(mandate.canonical_requirements_sha256, "canonical_requirements_sha256");
  requireNonEmptyString(mandate.canonical_envelope_sha256, "canonical_envelope_sha256");
  requireNonEmptyString(mandate.asset, "asset");
  requireNonEmptyString(mandate.pay_to, "pay_to");
  requireNonEmptyString(mandate.buyer_wallet, "buyer_wallet");
  if (mandate.payment_bearing_send_conditionally_authorized !== true) {
    fail(
      BLOCKED_B37_SEND_MANDATE_INVALID,
      "payment_bearing_send_conditionally_authorized must be true",
    );
  }
  if (mandate.max_payment_bearing_requests !== 1 || mandate.max_settlement_attempts !== 1) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "send/settlement maxima must be 1");
  }
  if (mandate.settlement_scope !== SETTLEMENT_SCOPE_SAME_EXACT_PAYMENT_FLOW) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "settlement_scope must be SAME_EXACT_PAYMENT_FLOW_ONLY");
  }
  if (mandate.allow_retry !== false || mandate.allow_resend !== false) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "retry and resend must be false");
  }
  if (
    mandate.allow_alternate_seller !== false ||
    mandate.allow_alternate_pay_to !== false ||
    mandate.allow_alternate_asset !== false ||
    mandate.allow_alternate_amount !== false
  ) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "alternate seller/payTo/asset/amount must be false");
  }
  if (mandate.credential_access_authorized !== false || mandate.real_signing_authorized !== false) {
    fail(
      BLOCKED_B37_SEND_MANDATE_INVALID,
      "send mandate must not authorize credential access or signing",
    );
  }
  if (mandate.requirements_change_policy !== REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "EXACT_MATCH_REQUIRED required");
  }
  const decidedMs = Date.parse(mandate.decided_at);
  const expiresMs = Date.parse(mandate.mandate_expires_at);
  if (!Number.isFinite(decidedMs) || !Number.isFinite(expiresMs) || !(decidedMs < expiresMs)) {
    fail(BLOCKED_B37_SEND_MANDATE_INVALID, "mandate temporal fields invalid");
  }
  if (!(input.now.getTime() < expiresMs)) {
    fail(
      BLOCKED_B37_SEND_MANDATE_EXPIRED,
      `conditional payment send mandate expired at ${mandate.mandate_expires_at}`,
    );
  }
  return mandate;
}

/** Synthetic fixture builder — not an operational human decision. */
export function buildSyntheticHumanConditionalPaymentSendMandate(input: {
  readonly decisionId: string;
  readonly provider?: string;
  readonly serviceId?: string;
  readonly endpoint: string;
  readonly method: string;
  readonly requestQuery?: CanonicalQueryPairs;
  readonly requestBody?: unknown | null;
  readonly requestBindingSha256: string;
  readonly x402Version?: number;
  readonly scheme?: string;
  readonly sellerNetworkRaw: string;
  readonly canonicalNetworkCaip2: string;
  readonly chainId?: number;
  readonly asset: string;
  readonly payTo: string;
  readonly buyerWallet: string;
  readonly amountAtomic?: string;
  readonly maximumAuthorizedAmountAtomic?: string;
  readonly canonicalRequirementsSha256: string;
  readonly canonicalEnvelopeSha256: string;
  readonly decidedAt: string;
  readonly mandateExpiresAt: string;
}): HumanConditionalPaymentSendMandate {
  const amount = input.amountAtomic ?? "1000";
  return {
    schema_version: HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_SCHEMA_VERSION,
    decision: HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE_DECISION,
    decision_id: input.decisionId,
    provider: input.provider ?? "discovered_x402",
    service_id: input.serviceId ?? "api_onesource_io_api_chain_block_number",
    endpoint: input.endpoint,
    method: input.method,
    request_query: input.requestQuery ?? [["network", "ethereum"]],
    request_body: input.requestBody ?? null,
    request_binding_sha256: input.requestBindingSha256,
    x402_version: input.x402Version ?? 2,
    scheme: input.scheme ?? "exact",
    seller_network_raw: input.sellerNetworkRaw,
    canonical_network_caip2: input.canonicalNetworkCaip2,
    chain_id: input.chainId ?? 8453,
    asset: input.asset,
    pay_to: input.payTo,
    buyer_wallet: input.buyerWallet,
    amount_atomic: amount,
    maximum_authorized_amount_atomic: input.maximumAuthorizedAmountAtomic ?? amount,
    canonical_requirements_sha256: input.canonicalRequirementsSha256,
    canonical_envelope_sha256: input.canonicalEnvelopeSha256,
    payment_bearing_send_conditionally_authorized: true,
    max_payment_bearing_requests: 1,
    max_settlement_attempts: 1,
    settlement_scope: SETTLEMENT_SCOPE_SAME_EXACT_PAYMENT_FLOW,
    allow_retry: false,
    allow_resend: false,
    allow_alternate_seller: false,
    allow_alternate_pay_to: false,
    allow_alternate_asset: false,
    allow_alternate_amount: false,
    credential_access_authorized: false,
    real_signing_authorized: false,
    requirements_change_policy: REQUIREMENTS_CHANGE_POLICY_EXACT_MATCH_REQUIRED,
    decided_at: input.decidedAt,
    mandate_expires_at: input.mandateExpiresAt,
  };
}
