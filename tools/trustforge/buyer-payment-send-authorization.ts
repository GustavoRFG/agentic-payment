/**
 * buyer-payment-send-authorization — machine-derived exact SEND authorization.
 *
 * Only this artifact (not the human send mandate) may authorize a payment-bearing
 * network request. Signing authorization alone is never sufficient.
 */

import {
  BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_EXPIRED,
  BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID,
  BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_MISSING,
  GUARD_PAYMENT_SEND_REQUIRES_EXACT_DERIVED_AUTHORIZATION,
  GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
} from "./b37-execution-gates";
import {
  SETTLEMENT_SCOPE_SAME_EXACT_PAYMENT_FLOW,
  type HumanConditionalPaymentSendMandate,
} from "./buyer-conditional-payment-send-mandate";
import type { BuyerSigningAuthorization } from "./buyer-signing-authorization";
import { isHumanConditionalCredentialSigningMandate } from "./buyer-conditional-credential-signing-mandate";
import { isHumanConditionalPaymentSendMandate } from "./buyer-conditional-payment-send-mandate";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const PAYMENT_SEND_AUTHORIZATION_SCHEMA_VERSION =
  "trustforge_payment_send_authorization.v1" as const;

export const PAYMENT_SEND_AUTHORIZATION_DECISION =
  "authorize_one_payment_bearing_request" as const;

export const DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE =
  "DETERMINISTIC_FROM_HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE" as const;

export interface PaymentSendAuthorization {
  readonly schema_version: typeof PAYMENT_SEND_AUTHORIZATION_SCHEMA_VERSION;
  readonly decision: typeof PAYMENT_SEND_AUTHORIZATION_DECISION;
  readonly decision_id: string;
  readonly derivation_type: typeof DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE;
  readonly authorization_schema_version: typeof PAYMENT_SEND_AUTHORIZATION_SCHEMA_VERSION;
  readonly parent_human_conditional_payment_send_mandate_sha256: string;
  readonly parent_human_conditional_credential_signing_mandate_sha256: string;
  readonly attempt_id: string;
  readonly run_id: string | null;
  readonly unsigned_artifact_sha256: string;
  readonly signed_artifact_sha256: string;
  readonly signing_authorization_sha256: string;
  readonly credential_access_authorization_sha256: string;
  readonly buyer_wallet: string;
  readonly asset: string;
  readonly pay_to: string;
  readonly amount_atomic: string;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  readonly chain_id: number;
  readonly endpoint: string;
  readonly method: string;
  readonly request_query: ReadonlyArray<readonly [string, string]>;
  readonly request_body: unknown | null;
  readonly request_binding_sha256: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly signature_attempt_id: string | null;
  readonly signer_address: string;
  readonly signed_at: string;
  readonly eip3009_valid_after: string;
  readonly eip3009_valid_before: string;
  readonly post_sign_jit_audit: "POST_SIGN_JIT_AUDIT_PASS";
  readonly payment_bearing_send_authorized: true;
  readonly max_payment_bearing_requests: 1;
  readonly max_settlement_attempts: 1;
  readonly settlement_scope: typeof SETTLEMENT_SCOPE_SAME_EXACT_PAYMENT_FLOW;
  readonly allow_retry: false;
  readonly allow_resend: false;
  readonly send_authorization_expires_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function paymentSendAuthorizationSha256(auth: PaymentSendAuthorization): string {
  return canonicalJsonSha256(auth);
}

export function isPaymentSendAuthorization(value: unknown): value is PaymentSendAuthorization {
  return (
    isRecord(value) && value.schema_version === PAYMENT_SEND_AUTHORIZATION_SCHEMA_VERSION
  );
}

/** Reject human mandates and signing authorizations as network send credentials. */
export function assertExactDerivedPaymentSendAuthorization(value: unknown): PaymentSendAuthorization {
  if (isHumanConditionalPaymentSendMandate(value)) {
    fail(
      GUARD_PAYMENT_SEND_REQUIRES_EXACT_DERIVED_AUTHORIZATION,
      "human send mandate cannot authorize network send directly",
    );
  }
  if (isHumanConditionalCredentialSigningMandate(value)) {
    fail(
      GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
      "credential/signing mandate cannot authorize payment-bearing send",
    );
  }
  if (
    isRecord(value) &&
    value.decision === "authorize_one_signature" &&
    value.payment_bearing_send_authorized === false
  ) {
    fail(
      GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
      "BuyerSigningAuthorization cannot authorize payment-bearing send",
    );
  }
  if (!isPaymentSendAuthorization(value)) {
    fail(
      GUARD_PAYMENT_SEND_REQUIRES_EXACT_DERIVED_AUTHORIZATION,
      "exact derived PaymentSendAuthorization required",
    );
  }
  return value;
}

export function assertSigningAuthorizationCannotAuthorizeSend(
  _auth: BuyerSigningAuthorization | null | undefined,
): never {
  fail(
    GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
    "BuyerSigningAuthorization cannot authorize payment-bearing send; derive PaymentSendAuthorization from HumanConditionalPaymentSendMandate",
  );
}

export function validatePaymentSendAuthorization(input: {
  readonly authorization: PaymentSendAuthorization | null | undefined;
  readonly now: Date;
}): PaymentSendAuthorization {
  const auth = input.authorization;
  if (!auth || !isRecord(auth as unknown)) {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_MISSING, "PaymentSendAuthorization required");
  }
  if (auth.schema_version !== PAYMENT_SEND_AUTHORIZATION_SCHEMA_VERSION) {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID, "unsupported schema_version");
  }
  if (auth.decision !== PAYMENT_SEND_AUTHORIZATION_DECISION) {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID, "unsupported decision");
  }
  if (auth.derivation_type !== DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE) {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID, "unsupported derivation_type");
  }
  if (auth.payment_bearing_send_authorized !== true) {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID, "send not authorized");
  }
  if (auth.max_payment_bearing_requests !== 1 || auth.allow_retry !== false || auth.allow_resend !== false) {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID, "one-shot send constraints violated");
  }
  if (auth.post_sign_jit_audit !== "POST_SIGN_JIT_AUDIT_PASS") {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID, "post-sign JIT audit must PASS");
  }
  const expiresMs = Date.parse(auth.send_authorization_expires_at);
  const validBeforeSec = Number(auth.eip3009_valid_before);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(validBeforeSec)) {
    fail(BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID, "temporal fields invalid");
  }
  if (expiresMs > validBeforeSec * 1000) {
    fail(
      BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_INVALID,
      "send authorization expiry must not exceed EIP-3009 validBefore",
    );
  }
  if (!(input.now.getTime() < expiresMs)) {
    fail(
      BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_EXPIRED,
      `PaymentSendAuthorization expired at ${auth.send_authorization_expires_at}`,
    );
  }
  if (!(Math.floor(input.now.getTime() / 1000) < validBeforeSec)) {
    fail(
      BLOCKED_B37_PAYMENT_SEND_AUTHORIZATION_EXPIRED,
      "EIP-3009 validBefore has passed",
    );
  }
  return auth;
}

export function buildPaymentSendAuthorization(input: {
  readonly sendMandate: HumanConditionalPaymentSendMandate;
  readonly sendMandateSha256: string;
  readonly signingMandateSha256: string;
  readonly attemptId: string;
  readonly runId: string | null;
  readonly unsignedArtifactSha256: string;
  readonly signedArtifactSha256: string;
  readonly signingAuthorizationSha256: string;
  readonly credentialAccessAuthorizationSha256: string;
  readonly buyerWallet: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
  readonly sellerNetworkRaw: string;
  readonly canonicalNetworkCaip2: string;
  readonly chainId: number;
  readonly endpoint: string;
  readonly method: string;
  readonly requestQuery: ReadonlyArray<readonly [string, string]>;
  readonly requestBody: unknown | null;
  readonly requestBindingSha256: string;
  readonly canonicalRequirementsSha256: string;
  readonly canonicalEnvelopeSha256: string;
  readonly signatureAttemptId: string | null;
  readonly signerAddress: string;
  readonly signedAt: string;
  readonly eip3009ValidAfter: string;
  readonly eip3009ValidBefore: string;
  readonly sendAuthorizationExpiresAt: string;
}): PaymentSendAuthorization {
  return {
    schema_version: PAYMENT_SEND_AUTHORIZATION_SCHEMA_VERSION,
    decision: PAYMENT_SEND_AUTHORIZATION_DECISION,
    decision_id: `derived_send_${input.sendMandate.decision_id}_${input.attemptId}`,
    derivation_type: DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE,
    authorization_schema_version: PAYMENT_SEND_AUTHORIZATION_SCHEMA_VERSION,
    parent_human_conditional_payment_send_mandate_sha256: input.sendMandateSha256,
    parent_human_conditional_credential_signing_mandate_sha256: input.signingMandateSha256,
    attempt_id: input.attemptId,
    run_id: input.runId,
    unsigned_artifact_sha256: input.unsignedArtifactSha256,
    signed_artifact_sha256: input.signedArtifactSha256,
    signing_authorization_sha256: input.signingAuthorizationSha256,
    credential_access_authorization_sha256: input.credentialAccessAuthorizationSha256,
    buyer_wallet: input.buyerWallet,
    asset: input.asset,
    pay_to: input.payTo,
    amount_atomic: input.amountAtomic,
    seller_network_raw: input.sellerNetworkRaw,
    canonical_network_caip2: input.canonicalNetworkCaip2,
    chain_id: input.chainId,
    endpoint: input.endpoint,
    method: input.method,
    request_query: input.requestQuery,
    request_body: input.requestBody,
    request_binding_sha256: input.requestBindingSha256,
    canonical_requirements_sha256: input.canonicalRequirementsSha256,
    canonical_envelope_sha256: input.canonicalEnvelopeSha256,
    signature_attempt_id: input.signatureAttemptId,
    signer_address: input.signerAddress,
    signed_at: input.signedAt,
    eip3009_valid_after: input.eip3009ValidAfter,
    eip3009_valid_before: input.eip3009ValidBefore,
    post_sign_jit_audit: "POST_SIGN_JIT_AUDIT_PASS",
    payment_bearing_send_authorized: true,
    max_payment_bearing_requests: 1,
    max_settlement_attempts: 1,
    settlement_scope: SETTLEMENT_SCOPE_SAME_EXACT_PAYMENT_FLOW,
    allow_retry: false,
    allow_resend: false,
    send_authorization_expires_at: input.sendAuthorizationExpiresAt,
  };
}
