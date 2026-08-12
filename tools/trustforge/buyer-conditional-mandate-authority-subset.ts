/**
 * buyer-conditional-mandate-authority-subset — dual authority ⊆ proofs.
 */

import {
  BLOCKED_B363_DERIVED_AUTHORITY_NOT_SUBSET,
  GUARD_DERIVED_CREDENTIAL_AUTHORITY_SUBSET,
  GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND,
} from "./b363-execution-gates";
import type { UnsignedArtifact } from "./buyer-authorization-artifacts";
import type { BuyerCredentialAccessAuthorization } from "./buyer-credential-access-authorization";
import { DERIVATION_TYPE_CREDENTIAL_FROM_HUMAN_CONDITIONAL_MANDATE } from "./buyer-credential-access-authorization";
import {
  B34_ONE_SHOT_PIPE_TRANSPORT,
  mandateAddressesEqual,
  type HumanConditionalCredentialSigningMandate,
} from "./buyer-conditional-credential-signing-mandate";
import type { BuyerSigningAuthorization } from "./buyer-signing-authorization";
import { DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE } from "./buyer-signing-authorization";
import type { SellerRequirementsObservation } from "./x402-seller-requirements-binding";

export interface DualAuthoritySubsetProof {
  readonly ok: true;
  readonly signing_subset: true;
  readonly credential_subset: true;
  readonly signing_does_not_authorize_send: true;
  readonly checked_fields: readonly string[];
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function verifyDerivedSigningAuthorizationIsSubsetOfConditionalMandate(input: {
  readonly mandate: HumanConditionalCredentialSigningMandate;
  readonly mandateSha256: string;
  readonly freshRequirements: SellerRequirementsObservation;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly derivedSigningAuthorization: BuyerSigningAuthorization;
}): { readonly ok: true; readonly checked_fields: readonly string[] } {
  const m = input.mandate;
  const d = input.derivedSigningAuthorization;
  const u = input.unsignedArtifact;
  const checked: string[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checked.push(label);
    if (!ok) {
      fail(BLOCKED_B363_DERIVED_AUTHORITY_NOT_SUBSET, detail ?? `${label} amplifies mandate`);
    }
  };

  check(
    "derivation_type",
    d.derivation_type === DERIVATION_TYPE_FROM_HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE,
  );
  check(
    "parent_hash",
    d.parent_human_conditional_credential_signing_mandate_sha256 === input.mandateSha256,
  );
  check("endpoint", d.endpoint === m.endpoint && u.endpoint === m.endpoint);
  check("method", d.method === m.method && u.method === m.method);
  check(
    "request_binding",
    d.request_binding_sha256 === m.request_binding_sha256 &&
      u.request_binding_sha256 === m.request_binding_sha256,
  );
  check(
    "requirements",
    d.canonical_requirements_sha256 === m.canonical_requirements_sha256,
  );
  check("envelope", d.canonical_envelope_sha256 === m.canonical_envelope_sha256);
  check("network", d.canonical_network_caip2 === m.canonical_network_caip2);
  check("asset", mandateAddressesEqual(d.asset, m.asset));
  check("pay_to", mandateAddressesEqual(d.pay_to, m.pay_to));
  check("buyer", mandateAddressesEqual(d.buyer_wallet, m.buyer_wallet));
  check(
    "amount",
    d.amount_atomic === m.amount_atomic &&
      u.seller_amount_atomic === m.amount_atomic &&
      BigInt(d.amount_atomic) <= BigInt(m.maximum_authorized_amount_atomic),
  );
  check("max_signatures", d.max_signatures === 1 && d.max_signatures <= m.max_signatures);
  check("allow_resign", d.allow_resign === false);
  check("send", d.payment_bearing_send_authorized === false);
  check("settlement", d.settlement_authorized === false);
  check(
    "unsigned_binding",
    d.unsigned_artifact_sha256 === input.unsignedArtifactSha256 &&
      d.attempt_id === u.attempt_id,
  );
  const derivedExpiry = Date.parse(d.signing_authorization_expires_at);
  const effectiveMs = Date.parse(d.effective_signing_deadline);
  const mandateMs = Date.parse(m.mandate_expires_at);
  check("expiry_not_beyond_effective", derivedExpiry <= effectiveMs);
  check("expiry_not_beyond_mandate", derivedExpiry <= mandateMs);
  if (d.payment_bearing_send_authorized !== false) {
    fail(GUARD_SIGNING_DOES_NOT_AUTHORIZE_SEND, "signing must not authorize send");
  }
  return { ok: true, checked_fields: checked };
}

export function verifyDerivedCredentialAccessAuthorizationIsSubsetOfConditionalMandate(input: {
  readonly mandate: HumanConditionalCredentialSigningMandate;
  readonly mandateSha256: string;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly signingAuthorization: BuyerSigningAuthorization;
  readonly signingAuthorizationSha256: string;
  readonly derivedCredentialAccessAuthorization: BuyerCredentialAccessAuthorization;
}): { readonly ok: true; readonly checked_fields: readonly string[] } {
  const m = input.mandate;
  const c = input.derivedCredentialAccessAuthorization;
  const checked: string[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checked.push(label);
    if (!ok) {
      fail(GUARD_DERIVED_CREDENTIAL_AUTHORITY_SUBSET, detail ?? `${label} amplifies mandate`);
    }
  };

  check(
    "derivation_type",
    c.derivation_type === DERIVATION_TYPE_CREDENTIAL_FROM_HUMAN_CONDITIONAL_MANDATE,
  );
  check(
    "parent_hash",
    c.parent_human_conditional_credential_signing_mandate_sha256 === input.mandateSha256,
  );
  check(
    "signing_auth_binding",
    c.signing_authorization_sha256 === input.signingAuthorizationSha256,
  );
  check(
    "unsigned_binding",
    c.unsigned_artifact_sha256 === input.unsignedArtifactSha256 &&
      c.attempt_id === input.unsignedArtifact.attempt_id,
  );
  check("provider_matches_mandate", c.provider_id === m.credential_provider_id);
  check("credential_kind_matches_mandate", c.credential_kind === m.credential_kind);
  check(
    "secret_entry",
    c.required_secret_entry_mechanism === m.secret_entry_mechanism,
  );
  check("transport", c.required_credential_transport === B34_ONE_SHOT_PIPE_TRANSPORT);
  check(
    "expected_signer",
    mandateAddressesEqual(c.expected_signer_address, m.buyer_wallet),
  );
  check("max_credential_acquisitions", c.max_credential_acquisitions === 1);
  check("max_signatures", c.max_signatures === 1);
  check("allow_fallback", c.allow_fallback === false);
  check("allow_resign", c.allow_resign === false);
  check("allow_reacquisition", c.allow_reacquisition === false);
  check("send", c.payment_bearing_send_authorized === false);
  check("settlement", c.settlement_authorized === false);

  const accessExpiry = Date.parse(c.access_expires_at);
  const signingExpiry = Date.parse(input.signingAuthorization.signing_authorization_expires_at);
  const effectiveMs = Date.parse(input.signingAuthorization.effective_signing_deadline);
  const mandateMs = Date.parse(m.mandate_expires_at);
  check(
    "access_expiry_cap",
    accessExpiry <= Math.min(effectiveMs, signingExpiry, mandateMs),
    "credential access expiry exceeds min(effective, signing auth, mandate)",
  );
  return { ok: true, checked_fields: checked };
}

export function verifyDualAuthoritySubsetOfConditionalMandate(input: {
  readonly mandate: HumanConditionalCredentialSigningMandate;
  readonly mandateSha256: string;
  readonly freshRequirements: SellerRequirementsObservation;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly derivedSigningAuthorization: BuyerSigningAuthorization;
  readonly signingAuthorizationSha256: string;
  readonly derivedCredentialAccessAuthorization: BuyerCredentialAccessAuthorization;
}): DualAuthoritySubsetProof {
  const signing = verifyDerivedSigningAuthorizationIsSubsetOfConditionalMandate({
    mandate: input.mandate,
    mandateSha256: input.mandateSha256,
    freshRequirements: input.freshRequirements,
    unsignedArtifact: input.unsignedArtifact,
    unsignedArtifactSha256: input.unsignedArtifactSha256,
    derivedSigningAuthorization: input.derivedSigningAuthorization,
  });
  const credential = verifyDerivedCredentialAccessAuthorizationIsSubsetOfConditionalMandate({
    mandate: input.mandate,
    mandateSha256: input.mandateSha256,
    unsignedArtifact: input.unsignedArtifact,
    unsignedArtifactSha256: input.unsignedArtifactSha256,
    signingAuthorization: input.derivedSigningAuthorization,
    signingAuthorizationSha256: input.signingAuthorizationSha256,
    derivedCredentialAccessAuthorization: input.derivedCredentialAccessAuthorization,
  });
  return {
    ok: true,
    signing_subset: true,
    credential_subset: true,
    signing_does_not_authorize_send: true,
    checked_fields: [...signing.checked_fields, ...credential.checked_fields],
  };
}
