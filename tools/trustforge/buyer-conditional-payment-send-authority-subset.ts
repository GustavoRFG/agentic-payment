/**
 * buyer-conditional-payment-send-authority-subset —
 * authority(PaymentSendAuthorization) ⊆ authority(HumanConditionalPaymentSendMandate)
 */

import {
  BLOCKED_B37_DERIVED_SEND_AUTHORITY_NOT_SUBSET,
  GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
} from "./b37-execution-gates";
import type { HumanConditionalPaymentSendMandate } from "./buyer-conditional-payment-send-mandate";
import { mandateAddressesEqual } from "./buyer-conditional-payment-send-mandate";
import {
  DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE,
  type PaymentSendAuthorization,
} from "./buyer-payment-send-authorization";
import type { BuyerSigningAuthorization } from "./buyer-signing-authorization";

export interface SendAuthoritySubsetProof {
  readonly ok: true;
  readonly send_subset: true;
  readonly signing_cannot_authorize_send: true;
  readonly checked_fields: readonly string[];
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function queryEqual(
  a: ReadonlyArray<readonly [string, string]>,
  b: ReadonlyArray<readonly [string, string]>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((pair, i) => pair[0] === b[i]![0] && pair[1] === b[i]![1]);
}

export function verifyDerivedPaymentSendAuthorizationIsSubsetOfSendMandate(input: {
  readonly sendMandate: HumanConditionalPaymentSendMandate;
  readonly sendMandateSha256: string;
  readonly signingMandateSha256: string;
  readonly derived: PaymentSendAuthorization;
  readonly unsignedArtifactSha256: string;
  readonly signedArtifactSha256: string;
  readonly signingAuthorizationSha256: string;
  readonly credentialAccessAuthorizationSha256: string;
  readonly attemptId: string;
}): SendAuthoritySubsetProof {
  const m = input.sendMandate;
  const d = input.derived;
  const checked: string[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checked.push(label);
    if (!ok) {
      fail(BLOCKED_B37_DERIVED_SEND_AUTHORITY_NOT_SUBSET, detail ?? `${label} amplifies mandate`);
    }
  };

  check(
    "derivation_type",
    d.derivation_type === DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_PAYMENT_SEND_MANDATE,
  );
  check(
    "parent_send_mandate",
    d.parent_human_conditional_payment_send_mandate_sha256 === input.sendMandateSha256,
  );
  check(
    "parent_signing_mandate",
    d.parent_human_conditional_credential_signing_mandate_sha256 === input.signingMandateSha256,
  );
  check("endpoint", d.endpoint === m.endpoint);
  check("method", d.method === m.method);
  check("query", queryEqual(d.request_query, m.request_query));
  check(
    "body",
    JSON.stringify(d.request_body ?? null) === JSON.stringify(m.request_body ?? null),
  );
  check("request_binding", d.request_binding_sha256 === m.request_binding_sha256);
  check("requirements", d.canonical_requirements_sha256 === m.canonical_requirements_sha256);
  check("envelope", d.canonical_envelope_sha256 === m.canonical_envelope_sha256);
  check("network", d.canonical_network_caip2 === m.canonical_network_caip2);
  check("seller_network_raw", d.seller_network_raw === m.seller_network_raw);
  check("chain_id", d.chain_id === m.chain_id);
  check("asset", mandateAddressesEqual(d.asset, m.asset));
  check("pay_to", mandateAddressesEqual(d.pay_to, m.pay_to));
  check("buyer", mandateAddressesEqual(d.buyer_wallet, m.buyer_wallet));
  check(
    "amount",
    d.amount_atomic === m.amount_atomic &&
      BigInt(d.amount_atomic) <= BigInt(m.maximum_authorized_amount_atomic),
  );
  check("max_payment_bearing_requests", d.max_payment_bearing_requests === 1);
  check("allow_retry", d.allow_retry === false);
  check("allow_resend", d.allow_resend === false);
  check("settlement_scope", d.settlement_scope === m.settlement_scope);
  check("attempt_id", d.attempt_id === input.attemptId);
  check("unsigned_hash", d.unsigned_artifact_sha256 === input.unsignedArtifactSha256);
  check("signed_hash", d.signed_artifact_sha256 === input.signedArtifactSha256);
  check("signing_auth_hash", d.signing_authorization_sha256 === input.signingAuthorizationSha256);
  check(
    "credential_auth_hash",
    d.credential_access_authorization_sha256 === input.credentialAccessAuthorizationSha256,
  );
  check("post_sign_audit", d.post_sign_jit_audit === "POST_SIGN_JIT_AUDIT_PASS");

  const derivedExpiry = Date.parse(d.send_authorization_expires_at);
  const mandateExpiry = Date.parse(m.mandate_expires_at);
  const validBeforeMs = Number(d.eip3009_valid_before) * 1000;
  check("expiry_not_beyond_mandate", derivedExpiry <= mandateExpiry);
  check("expiry_not_beyond_validBefore", derivedExpiry <= validBeforeMs);

  return {
    ok: true,
    send_subset: true,
    signing_cannot_authorize_send: true,
    checked_fields: checked,
  };
}

export function assertSigningAuthRejectedAsSendAuthority(
  signingAuth: BuyerSigningAuthorization,
): void {
  if (signingAuth.payment_bearing_send_authorized !== false) {
    fail(
      GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
      "signing authorization must keep payment_bearing_send_authorized=false",
    );
  }
  fail(
    GUARD_SIGNING_AUTHORIZATION_CANNOT_AUTHORIZE_SEND,
    "signing authorization cannot authorize send",
  );
}
