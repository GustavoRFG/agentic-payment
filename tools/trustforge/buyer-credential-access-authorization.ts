/**
 * buyer-credential-access-authorization — one-shot privilege to open credentials.
 *
 * Independent of prepare and of payment-bearing send. This module validates the
 * contract; it never creates an operational authorization for a live candidate
 * and never opens secrets.
 */

import {
  BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_EXPIRED,
  BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
  BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING,
  BLOCKED_B31_PROVIDER_MISMATCH,
} from "./b31-execution-gates";
import { assertNotHumanConditionalMandateForCredential } from "./buyer-conditional-credential-signing-mandate";
import { B34_ONE_SHOT_PIPE_TRANSPORT } from "./buyer-conditional-credential-signing-mandate";
import { B35_SECRET_ENTRY_MECHANISM } from "./buyer-hidden-tty-secret-entry";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";
import type { UnsignedArtifact } from "./buyer-authorization-artifacts";
import type { BuyerSigningAuthorization } from "./buyer-signing-authorization";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "./explicit-runtime-key-credential-provider";

export const BUYER_CREDENTIAL_ACCESS_AUTHORIZATION_SCHEMA_VERSION =
  "trustforge_buyer_credential_access_authorization.v1" as const;

export const DERIVATION_TYPE_CREDENTIAL_FROM_HUMAN_CONDITIONAL_MANDATE =
  "DETERMINISTIC_FROM_HUMAN_CONDITIONAL_CREDENTIAL_SIGNING_MANDATE" as const;

export interface BuyerCredentialAccessAuthorization {
  readonly authorization_schema_version: typeof BUYER_CREDENTIAL_ACCESS_AUTHORIZATION_SCHEMA_VERSION;
  readonly decision: "authorize_one_credential_access";
  readonly decision_id: string;
  readonly signing_authorization_sha256: string;
  readonly unsigned_artifact_sha256: string;
  readonly attempt_id: string;
  readonly run_id: string;
  readonly provider_id: string;
  readonly credential_kind: string;
  readonly expected_signer_address: string;
  readonly access_expires_at: string;
  readonly max_credential_acquisitions: 1;
  readonly max_signatures: 1;
  readonly allow_fallback: false;
  readonly allow_resign: false;
  readonly prepare_authorized: true;
  readonly real_signing_authorized: true;
  readonly credential_access_authorized: true;
  readonly payment_bearing_send_authorized: false;
  readonly settlement_authorized: false;
  readonly parent_human_conditional_credential_signing_mandate_sha256?: string;
  readonly derivation_type?: typeof DERIVATION_TYPE_CREDENTIAL_FROM_HUMAN_CONDITIONAL_MANDATE;
  readonly required_secret_entry_mechanism?: typeof B35_SECRET_ENTRY_MECHANISM;
  readonly required_credential_transport?: typeof B34_ONE_SHOT_PIPE_TRANSPORT;
  readonly allow_reacquisition?: false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function buyerCredentialAccessAuthorizationSha256(
  authorization: BuyerCredentialAccessAuthorization,
): string {
  return canonicalJsonSha256(authorization);
}

export function validateBuyerCredentialAccessAuthorization(input: {
  readonly authorization: BuyerCredentialAccessAuthorization | null | undefined;
  readonly signingAuthorization: BuyerSigningAuthorization;
  readonly signingAuthorizationSha256: string;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly providerId: string;
  readonly credentialKind: string;
  readonly expectedSignerAddress: string;
  readonly now: Date;
}): BuyerCredentialAccessAuthorization {
  assertNotHumanConditionalMandateForCredential(input.authorization);
  const auth = input.authorization;
  if (!auth || !isRecord(auth as unknown)) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING,
      "credential-access authorization is required before privileged credential acquisition",
    );
  }
  if (auth.authorization_schema_version !== BUYER_CREDENTIAL_ACCESS_AUTHORIZATION_SCHEMA_VERSION) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "unsupported credential-access authorization schema_version",
    );
  }
  if (auth.decision !== "authorize_one_credential_access") {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "decision must be authorize_one_credential_access",
    );
  }
  if (typeof auth.decision_id !== "string" || auth.decision_id.trim().length === 0) {
    fail(BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID, "decision_id is required");
  }
  if (
    auth.max_credential_acquisitions !== 1 ||
    auth.max_signatures !== 1 ||
    auth.allow_fallback !== false ||
    auth.allow_resign !== false
  ) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "one-shot credential/signature limits and no-fallback/no-resign are required",
    );
  }
  if (
    auth.prepare_authorized !== true ||
    auth.real_signing_authorized !== true ||
    auth.credential_access_authorized !== true
  ) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "prepare, signing, and credential-access privileges must be explicitly true",
    );
  }
  if (
    auth.payment_bearing_send_authorized !== false ||
    auth.settlement_authorized !== false
  ) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "credential-access authorization must not grant send or settlement",
    );
  }
  if (auth.signing_authorization_sha256 !== input.signingAuthorizationSha256) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "signing_authorization_sha256 mismatch",
    );
  }
  if (auth.unsigned_artifact_sha256 !== input.unsignedArtifactSha256) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "unsigned_artifact_sha256 mismatch",
    );
  }
  if (
    auth.attempt_id !== input.unsignedArtifact.attempt_id ||
    auth.run_id !== input.unsignedArtifact.run_id
  ) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "run/attempt binding mismatch",
    );
  }
  if (auth.provider_id !== input.providerId) {
    fail(BLOCKED_B31_PROVIDER_MISMATCH, "provider_id does not match selected provider");
  }
  if (auth.credential_kind !== input.credentialKind) {
    fail(BLOCKED_B31_PROVIDER_MISMATCH, "credential_kind does not match selected provider");
  }
  if (!sameAddress(auth.expected_signer_address, input.expectedSignerAddress)) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "expected_signer_address does not match the prepared unsigned buyer",
    );
  }
  if (!sameAddress(auth.expected_signer_address, input.signingAuthorization.buyer_wallet)) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "expected_signer_address does not match signing authorization buyer",
    );
  }
  const expiresMs = Date.parse(auth.access_expires_at);
  if (!Number.isFinite(expiresMs)) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "access_expires_at is not a usable timestamp",
    );
  }
  if (!(input.now.getTime() < expiresMs)) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_EXPIRED,
      `credential-access authorization expired at ${auth.access_expires_at}`,
    );
  }
  const hasParent =
    typeof auth.parent_human_conditional_credential_signing_mandate_sha256 === "string";
  const hasDerivation = auth.derivation_type !== undefined;
  if (hasParent !== hasDerivation) {
    fail(
      BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
      "parent conditional mandate hash and derivation_type must be set together",
    );
  }
  if (hasDerivation) {
    if (auth.derivation_type !== DERIVATION_TYPE_CREDENTIAL_FROM_HUMAN_CONDITIONAL_MANDATE) {
      fail(
        BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
        "unsupported credential derivation_type",
      );
    }
    if (
      !/^[0-9a-f]{64}$/.test(auth.parent_human_conditional_credential_signing_mandate_sha256!)
    ) {
      fail(
        BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
        "parent_human_conditional_credential_signing_mandate_sha256 must be a 64-char lowercase hex digest",
      );
    }
    if (auth.provider_id !== EXPLICIT_RUNTIME_KEY_PROVIDER_ID) {
      fail(
        BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
        "derived credential auth requires explicit-runtime-key",
      );
    }
    if (auth.credential_kind !== EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND) {
      fail(
        BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
        "derived credential auth credential_kind mismatch",
      );
    }
    if (auth.required_secret_entry_mechanism !== B35_SECRET_ENTRY_MECHANISM) {
      fail(
        BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
        "derived credential auth requires HIDDEN_PARENT_TTY_ONE_SHOT",
      );
    }
    if (auth.required_credential_transport !== B34_ONE_SHOT_PIPE_TRANSPORT) {
      fail(
        BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
        "derived credential auth requires B34_ONE_SHOT_PIPE",
      );
    }
    if (auth.allow_reacquisition !== false) {
      fail(
        BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID,
        "allow_reacquisition must be false",
      );
    }
  }
  return auth;
}

/** Synthetic fixture builder — not an operational human decision. */
export function buildSyntheticBuyerCredentialAccessAuthorization(input: {
  readonly decisionId: string;
  readonly signingAuthorization: BuyerSigningAuthorization;
  readonly signingAuthorizationSha256: string;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly providerId: string;
  readonly credentialKind: string;
  readonly expectedSignerAddress: string;
  readonly accessExpiresAt: string;
}): BuyerCredentialAccessAuthorization {
  return {
    authorization_schema_version: BUYER_CREDENTIAL_ACCESS_AUTHORIZATION_SCHEMA_VERSION,
    decision: "authorize_one_credential_access",
    decision_id: input.decisionId,
    signing_authorization_sha256: input.signingAuthorizationSha256,
    unsigned_artifact_sha256: input.unsignedArtifactSha256,
    attempt_id: input.unsignedArtifact.attempt_id,
    run_id: input.unsignedArtifact.run_id,
    provider_id: input.providerId,
    credential_kind: input.credentialKind,
    expected_signer_address: input.expectedSignerAddress,
    access_expires_at: input.accessExpiresAt,
    max_credential_acquisitions: 1,
    max_signatures: 1,
    allow_fallback: false,
    allow_resign: false,
    prepare_authorized: true,
    real_signing_authorized: true,
    credential_access_authorized: true,
    payment_bearing_send_authorized: false,
    settlement_authorized: false,
  };
}

/** Machine-derived credential-access authorization from a conditional mandate. */
export function buildDerivedBuyerCredentialAccessAuthorizationFromConditionalMandate(input: {
  readonly decisionId: string;
  readonly parentConditionalMandateSha256: string;
  readonly signingAuthorization: BuyerSigningAuthorization;
  readonly signingAuthorizationSha256: string;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly accessExpiresAt: string;
}): BuyerCredentialAccessAuthorization {
  const base = buildSyntheticBuyerCredentialAccessAuthorization({
    decisionId: input.decisionId,
    signingAuthorization: input.signingAuthorization,
    signingAuthorizationSha256: input.signingAuthorizationSha256,
    unsignedArtifact: input.unsignedArtifact,
    unsignedArtifactSha256: input.unsignedArtifactSha256,
    providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
    expectedSignerAddress: input.unsignedArtifact.buyer_wallet,
    accessExpiresAt: input.accessExpiresAt,
  });
  return {
    ...base,
    parent_human_conditional_credential_signing_mandate_sha256:
      input.parentConditionalMandateSha256,
    derivation_type: DERIVATION_TYPE_CREDENTIAL_FROM_HUMAN_CONDITIONAL_MANDATE,
    required_secret_entry_mechanism: B35_SECRET_ENTRY_MECHANISM,
    required_credential_transport: B34_ONE_SHOT_PIPE_TRANSPORT,
    allow_reacquisition: false,
  };
}
