/**
 * buyer-mandate-authority-subset — derived signing auth ⊆ human mandate.
 *
 * Pure verifier. No credential access, no signer, no network.
 */

import { BLOCKED_B361_DERIVED_AUTHORITY_NOT_SUBSET } from "./b361-execution-gates";
import type { UnsignedArtifact } from "./buyer-authorization-artifacts";
import {
  mandateAddressesEqual,
  type HumanOneShotSigningMandate,
} from "./buyer-one-shot-signing-mandate";
import type { BuyerSigningAuthorization } from "./buyer-signing-authorization";
import { DERIVATION_TYPE_FROM_HUMAN_ONE_SHOT_SIGNING_MANDATE } from "./buyer-signing-authorization";
import type { SellerRequirementsObservation } from "./x402-seller-requirements-binding";

export interface AuthoritySubsetProof {
  readonly ok: true;
  readonly invariant: "authority(derived) ⊆ authority(human_mandate)";
  readonly checked_fields: readonly string[];
}

function fail(detail: string): never {
  throw new Error(`${BLOCKED_B361_DERIVED_AUTHORITY_NOT_SUBSET}: ${detail}`);
}

/**
 * Verify derived signing authorization does not amplify the human mandate.
 */
export function verifyDerivedSigningAuthorizationIsSubsetOfMandate(input: {
  readonly mandate: HumanOneShotSigningMandate;
  readonly mandateSha256: string;
  readonly freshRequirements: SellerRequirementsObservation;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly derivedSigningAuthorization: BuyerSigningAuthorization;
}): AuthoritySubsetProof {
  const m = input.mandate;
  const d = input.derivedSigningAuthorization;
  const u = input.unsignedArtifact;
  const b = input.freshRequirements.binding;
  const checked: string[] = [];

  const check = (label: string, ok: boolean, detail?: string) => {
    checked.push(label);
    if (!ok) fail(detail ?? `${label} amplifies or mismatches mandate`);
  };

  check(
    "derivation_type",
    d.derivation_type === DERIVATION_TYPE_FROM_HUMAN_ONE_SHOT_SIGNING_MANDATE,
    "derivation_type must be DETERMINISTIC_FROM_HUMAN_ONE_SHOT_SIGNING_MANDATE",
  );
  check(
    "parent_mandate_hash",
    d.parent_human_one_shot_signing_mandate_sha256 === input.mandateSha256,
    "parent mandate hash mismatch",
  );
  check("endpoint", d.endpoint === m.endpoint && u.endpoint === m.endpoint);
  check("method", d.method === m.method && u.method === m.method);
  check(
    "request_binding",
    d.request_binding_sha256 === m.request_binding_sha256 &&
      u.request_binding_sha256 === m.request_binding_sha256 &&
      b.request_binding_sha256 === m.request_binding_sha256,
  );
  check(
    "requirements_hash",
    d.canonical_requirements_sha256 === m.canonical_requirements_sha256 &&
      u.canonical_requirements_sha256 === m.canonical_requirements_sha256,
  );
  check(
    "envelope_hash",
    d.canonical_envelope_sha256 === m.canonical_envelope_sha256 &&
      u.canonical_envelope_sha256 === m.canonical_envelope_sha256,
  );
  check(
    "network",
    d.canonical_network_caip2 === m.canonical_network_caip2 &&
      u.canonical_network_caip2 === m.canonical_network_caip2,
  );
  check(
    "asset",
    mandateAddressesEqual(d.asset, m.asset) && mandateAddressesEqual(u.asset, m.asset),
  );
  check(
    "pay_to",
    mandateAddressesEqual(d.pay_to, m.pay_to) && mandateAddressesEqual(u.pay_to, m.pay_to),
  );
  check(
    "buyer",
    mandateAddressesEqual(d.buyer_wallet, m.buyer_wallet) &&
      mandateAddressesEqual(u.buyer_wallet, m.buyer_wallet),
  );
  check(
    "amount",
    d.amount_atomic === m.amount_atomic &&
      u.seller_amount_atomic === m.amount_atomic &&
      b.amount_atomic === m.amount_atomic,
  );
  check(
    "amount_within_maximum",
    BigInt(d.amount_atomic) <= BigInt(m.maximum_authorized_amount_atomic),
  );
  check("max_signatures", d.max_signatures === 1 && d.max_signatures <= m.max_signatures);
  check("allow_resign", d.allow_resign === false && m.allow_resign === false);
  check(
    "send_scope",
    d.payment_bearing_send_authorized === false &&
      m.payment_bearing_send_authorized === false,
  );
  check(
    "settlement_scope",
    d.settlement_authorized === false && m.settlement_authorized === false,
  );
  check(
    "credential_scope",
    m.credential_access_authorized === false,
    "mandate must not authorize credential access",
  );
  check(
    "unsigned_binding",
    d.unsigned_artifact_sha256 === input.unsignedArtifactSha256 &&
      d.attempt_id === u.attempt_id &&
      d.run_id === u.run_id,
  );
  check(
    "effective_deadline_bound",
    d.effective_signing_deadline === u.effective_signing_deadline,
  );

  const derivedExpiryMs = Date.parse(d.signing_authorization_expires_at);
  const mandateExpiryMs = Date.parse(m.mandate_expires_at);
  const effectiveMs = Date.parse(d.effective_signing_deadline);
  check(
    "signing_auth_expiry_not_beyond_effective",
    Number.isFinite(derivedExpiryMs) && derivedExpiryMs <= effectiveMs,
    "derived signing authorization expiry exceeds effective_signing_deadline",
  );
  check(
    "signing_auth_expiry_not_beyond_mandate",
    Number.isFinite(derivedExpiryMs) && derivedExpiryMs <= mandateExpiryMs,
    "derived signing authorization expiry exceeds human mandate expiry",
  );
  check(
    "lifetime_not_extended",
    effectiveMs <= mandateExpiryMs,
    "effective signing deadline exceeds human mandate expiry",
  );

  return {
    ok: true,
    invariant: "authority(derived) ⊆ authority(human_mandate)",
    checked_fields: checked,
  };
}
