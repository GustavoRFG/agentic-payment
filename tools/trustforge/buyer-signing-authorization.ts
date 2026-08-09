/**
 * buyer-signing-authorization — one-shot decision to sign a specific unsigned artifact.
 *
 * Independent of prepare authorization and of payment-bearing send authorization.
 * This module validates the contract shape; it never creates an operational
 * authorization for a live candidate and never touches credentials.
 */

import {
  BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_EXPIRED,
  BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
  BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_MISSING,
} from "./b3-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";
import type { UnsignedArtifact } from "./buyer-authorization-artifacts";

export const BUYER_SIGNING_AUTHORIZATION_SCHEMA_VERSION =
  "trustforge_buyer_signing_authorization.v1" as const;

export interface BuyerSigningAuthorization {
  readonly authorization_schema_version: typeof BUYER_SIGNING_AUTHORIZATION_SCHEMA_VERSION;
  readonly decision: "authorize_one_signature";
  readonly decision_id: string;
  readonly prepare_authorization_sha256: string;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly unsigned_artifact_sha256: string;
  readonly buyer_wallet: string;
  readonly endpoint: string;
  readonly method: string;
  readonly request_binding_sha256: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly asset: string;
  readonly pay_to: string;
  readonly amount_atomic: string;
  readonly canonical_network_caip2: string;
  readonly effective_signing_deadline: string;
  readonly signing_authorization_expires_at: string;
  readonly max_signatures: 1;
  readonly allow_resign: false;
  readonly prepare_authorized: true;
  readonly real_signing_authorized: true;
  readonly payment_bearing_send_authorized: false;
  readonly settlement_authorized: false;
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

export function buyerSigningAuthorizationSha256(
  authorization: BuyerSigningAuthorization,
): string {
  return canonicalJsonSha256(authorization);
}

/**
 * Validate a signing authorization against the specific unsigned artifact it
 * is allowed to sign. Does not invoke a signer.
 */
export function validateBuyerSigningAuthorization(input: {
  readonly authorization: BuyerSigningAuthorization | null | undefined;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly prepareAuthorizationSha256: string;
  readonly now: Date;
}): BuyerSigningAuthorization {
  const auth = input.authorization;
  if (!auth || !isRecord(auth as unknown)) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_MISSING,
      "signing authorization artifact is required before any signer invocation",
    );
  }
  if (auth.authorization_schema_version !== BUYER_SIGNING_AUTHORIZATION_SCHEMA_VERSION) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "unsupported signing authorization schema_version",
    );
  }
  if (auth.decision !== "authorize_one_signature") {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "decision must be authorize_one_signature",
    );
  }
  if (typeof auth.decision_id !== "string" || auth.decision_id.trim().length === 0) {
    fail(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID, "decision_id is required");
  }
  if (auth.max_signatures !== 1 || auth.allow_resign !== false) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "max_signatures must be 1 and allow_resign must be false",
    );
  }
  if (auth.prepare_authorized !== true || auth.real_signing_authorized !== true) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "prepare_authorized and real_signing_authorized must be true",
    );
  }
  if (
    auth.payment_bearing_send_authorized !== false ||
    auth.settlement_authorized !== false
  ) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "signing authorization must not grant send or settlement",
    );
  }
  if (auth.prepare_authorization_sha256 !== input.prepareAuthorizationSha256) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "prepare_authorization_sha256 does not match the prepare authorization",
    );
  }
  if (auth.unsigned_artifact_sha256 !== input.unsignedArtifactSha256) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "unsigned_artifact_sha256 does not match the prepared unsigned artifact",
    );
  }
  const u = input.unsignedArtifact;
  if (auth.run_id !== u.run_id || auth.attempt_id !== u.attempt_id) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "signing authorization run/attempt does not match the unsigned artifact",
    );
  }
  if (auth.endpoint !== u.endpoint || auth.method !== u.method) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "endpoint/method does not match the unsigned artifact",
    );
  }
  if (auth.request_binding_sha256 !== u.request_binding_sha256) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "request_binding_sha256 mismatch",
    );
  }
  if (auth.canonical_requirements_sha256 !== u.canonical_requirements_sha256) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "requirements hash mismatch",
    );
  }
  if (auth.canonical_envelope_sha256 !== u.canonical_envelope_sha256) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "envelope hash mismatch",
    );
  }
  if (!sameAddress(auth.buyer_wallet, u.buyer_wallet)) {
    fail(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID, "buyer wallet mismatch");
  }
  if (!sameAddress(auth.asset, u.asset)) {
    fail(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID, "asset mismatch");
  }
  if (!sameAddress(auth.pay_to, u.pay_to)) {
    fail(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID, "payTo mismatch");
  }
  if (auth.amount_atomic !== u.seller_amount_atomic) {
    fail(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID, "amount mismatch");
  }
  if (auth.canonical_network_caip2 !== u.canonical_network_caip2) {
    fail(BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID, "network mismatch");
  }
  if (auth.effective_signing_deadline !== u.effective_signing_deadline) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "effective_signing_deadline mismatch",
    );
  }
  const expiresMs = Date.parse(auth.signing_authorization_expires_at);
  if (!Number.isFinite(expiresMs)) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID,
      "signing_authorization_expires_at is not a usable timestamp",
    );
  }
  if (!(input.now.getTime() < expiresMs)) {
    fail(
      BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_EXPIRED,
      `signing authorization expired at ${auth.signing_authorization_expires_at}`,
    );
  }
  return auth;
}

/**
 * Build a synthetic signing authorization for offline fixtures/tests.
 * Not an operational human decision for a live candidate.
 */
export function buildSyntheticBuyerSigningAuthorization(input: {
  readonly decisionId: string;
  readonly prepareAuthorizationSha256: string;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly signingAuthorizationExpiresAt: string;
}): BuyerSigningAuthorization {
  const u = input.unsignedArtifact;
  return {
    authorization_schema_version: BUYER_SIGNING_AUTHORIZATION_SCHEMA_VERSION,
    decision: "authorize_one_signature",
    decision_id: input.decisionId,
    prepare_authorization_sha256: input.prepareAuthorizationSha256,
    run_id: u.run_id,
    attempt_id: u.attempt_id,
    unsigned_artifact_sha256: input.unsignedArtifactSha256,
    buyer_wallet: u.buyer_wallet,
    endpoint: u.endpoint,
    method: u.method,
    request_binding_sha256: u.request_binding_sha256,
    canonical_requirements_sha256: u.canonical_requirements_sha256,
    canonical_envelope_sha256: u.canonical_envelope_sha256,
    asset: u.asset,
    pay_to: u.pay_to,
    amount_atomic: u.seller_amount_atomic,
    canonical_network_caip2: u.canonical_network_caip2,
    effective_signing_deadline: u.effective_signing_deadline,
    signing_authorization_expires_at: input.signingAuthorizationExpiresAt,
    max_signatures: 1,
    allow_resign: false,
    prepare_authorized: true,
    real_signing_authorized: true,
    payment_bearing_send_authorized: false,
    settlement_authorized: false,
  };
}
