/**
 * buyer-pre-sign-validation — mandatory current-time gate before any signer call.
 *
 * UNSIGNED_PERSISTED is evidence, not a signability grant. Signability is decided
 * only when this validator accepts the persisted attempt against injected `now`.
 * This module never receives or invokes a signer.
 */

import {
  BUYER_AUTHORIZATION_ARTIFACT_SCHEMA_VERSION,
  type AttemptArtifactInput,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import {
  BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
  BLOCKED_PAYMENT_REQUIREMENTS_STALE,
  BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
  canonicalJsonSha256,
} from "./x402-seller-requirements-binding";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";

export const BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID =
  "BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID" as const;
export const BLOCKED_BUYER_ATTEMPT_STATE_NOT_SIGNABLE =
  "BLOCKED_BUYER_ATTEMPT_STATE_NOT_SIGNABLE" as const;
/** Same stable code as buyer-eip3009-authorization (kept local to avoid import cycles). */
export const BLOCKED_HUMAN_AUTHORIZATION_EXPIRED =
  "BLOCKED_HUMAN_AUTHORIZATION_EXPIRED" as const;

/** Re-export stable temporal blockers for call-site convenience. */
export {
  BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
  BLOCKED_PAYMENT_REQUIREMENTS_STALE,
};

/** Persisted attempt ledger row (reservation identity). */
export type PreSignAttemptArtifact = AttemptArtifactInput;

export interface PreSignValidationInput {
  readonly unsignedArtifact: UnsignedArtifact;
  readonly attempt: PreSignAttemptArtifact;
  readonly humanAuthorization: HumanPaymentAuthorization;
  readonly now: Date;
  /** When set, must equal canonicalJsonSha256(unsignedArtifact). */
  readonly expectedUnsignedHash?: string | null;
}

export interface PreSignValidationResult {
  readonly ok: true;
  readonly unsigned_artifact_sha256: string;
  readonly human_authorization_sha256: string;
  readonly now_unix_seconds: number;
  readonly valid_before_unix_seconds: number;
  readonly effective_signing_deadline: string;
  readonly human_authorization_expires_at: string;
}

const NONCE_SHAPE = /^0x[0-9a-f]{64}$/;
const EXPECTED_PRIMARY_TYPE = "TransferWithAuthorization";
const EXPECTED_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function requireFiniteMs(value: string, label: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, `${label} is not a usable timestamp`);
  }
  return ms;
}

function requireUintSeconds(value: string, label: string): number {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    fail(BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID, `${label} is not an integer second string`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) {
    fail(BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID, `${label} is not a safe non-negative integer`);
  }
  return n;
}

/**
 * Temporal comparisons:
 * - human expiry and effective deadline: millisecond instants (`now.getTime() < deadlineMs`)
 * - EIP-3009 validBefore / validAfter: integer Unix seconds
 *   (`Math.floor(now.getTime()/1000) < validBeforeSeconds`)
 * Equality with a deadline is always BLOCK (not signable at the boundary).
 */
export function validateBuyerAuthorizationBeforeSigning(
  input: PreSignValidationInput,
): PreSignValidationResult {
  const { unsignedArtifact: u, attempt, humanAuthorization: human, now } = input;

  if (u.schema_version !== BUYER_AUTHORIZATION_ARTIFACT_SCHEMA_VERSION) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      `unsigned schema_version ${String(u.schema_version)} is not accepted`,
    );
  }
  if (attempt.schema_version !== BUYER_AUTHORIZATION_ARTIFACT_SCHEMA_VERSION) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      `attempt schema_version ${String(attempt.schema_version)} is not accepted`,
    );
  }
  if (u.attempt_id !== attempt.attempt_id) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "unsigned attempt_id does not match attempt ledger",
    );
  }
  if (u.run_id !== attempt.run_id) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "unsigned run_id does not match attempt ledger",
    );
  }

  if (u.state !== "UNSIGNED_PERSISTED") {
    fail(
      BLOCKED_BUYER_ATTEMPT_STATE_NOT_SIGNABLE,
      `unsigned state ${String(u.state)} is not UNSIGNED_PERSISTED`,
    );
  }
  // Reservation ledger stays RESERVED after unsigned persist; anything else is not signable.
  if (attempt.state !== "RESERVED") {
    fail(
      BLOCKED_BUYER_ATTEMPT_STATE_NOT_SIGNABLE,
      `attempt ledger state ${String(attempt.state)} is not a reserved signable attempt`,
    );
  }

  const unsignedHash = canonicalJsonSha256(u);
  if (input.expectedUnsignedHash != null && input.expectedUnsignedHash !== unsignedHash) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "unsigned artifact hash does not match expectedUnsignedHash",
    );
  }

  const humanHash = canonicalJsonSha256(human);
  if (u.human_authorization_sha256 !== humanHash) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "human authorization hash does not match the unsigned artifact binding",
    );
  }

  if (
    typeof human.canonical_requirements_sha256 === "string" &&
    human.canonical_requirements_sha256 !== u.canonical_requirements_sha256
  ) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "requirements hash does not match human authorization",
    );
  }
  if (
    typeof human.canonical_envelope_sha256 === "string" &&
    human.canonical_envelope_sha256 !== u.canonical_envelope_sha256
  ) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "envelope hash does not match human authorization",
    );
  }
  if (
    typeof human.request_binding_sha256 === "string" &&
    human.request_binding_sha256 !== u.request_binding_sha256
  ) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "request-binding hash does not match human authorization",
    );
  }
  if (human.endpoint !== u.endpoint || (human.method ?? null) !== u.method) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "endpoint/method does not match human authorization",
    );
  }
  if (attempt.endpoint !== u.endpoint || attempt.method !== u.method) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "endpoint/method does not match attempt ledger",
    );
  }

  if (!human.buyer_wallet || !sameAddress(human.buyer_wallet, u.buyer_wallet)) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "buyer wallet binding mismatch");
  }
  if (human.asset && !sameAddress(human.asset, u.asset)) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "asset binding mismatch");
  }
  if (human.pay_to && !sameAddress(human.pay_to, u.pay_to)) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "payTo binding mismatch");
  }
  if (human.amount_atomic && human.amount_atomic !== u.seller_amount_atomic) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "amount binding mismatch");
  }
  if (
    human.canonical_network_caip2 &&
    human.canonical_network_caip2 !== u.canonical_network_caip2
  ) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "canonical network binding mismatch");
  }
  if (u.domain.verifyingContract.toLowerCase() !== u.asset.toLowerCase()) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "domain verifyingContract is not asset");
  }
  if (u.domain.chainId !== u.chain_id) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "domain chainId does not match chain_id");
  }
  if (u.message.from.toLowerCase() !== u.buyer_wallet.toLowerCase()) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "typed-data from is not buyer_wallet");
  }
  if (u.message.to.toLowerCase() !== u.pay_to.toLowerCase()) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "typed-data to is not pay_to");
  }
  if (u.message.value !== u.seller_amount_atomic) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "typed-data value is not seller amount");
  }
  if (u.message.validAfter !== u.valid_after || u.message.validBefore !== u.valid_before) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "typed-data validity fields do not match artifact validity fields",
    );
  }
  if (u.message.nonce !== u.nonce) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "typed-data nonce is not artifact nonce");
  }
  if (!NONCE_SHAPE.test(u.nonce)) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "buyer nonce must be 0x followed by 64 lowercase hex characters (32 bytes)",
    );
  }

  if (u.primary_type !== EXPECTED_PRIMARY_TYPE) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "primary_type is not TransferWithAuthorization");
  }
  if (canonicalJsonSha256(u.types) !== canonicalJsonSha256(EXPECTED_TYPES)) {
    fail(BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID, "EIP-712 types do not match the B.2 contract");
  }
  const typedCore = {
    domain: u.domain,
    types: u.types,
    primary_type: u.primary_type,
    message: u.message,
  };
  if (canonicalJsonSha256(typedCore) !== u.canonical_unsigned_payload_sha256) {
    fail(
      BLOCKED_BUYER_UNSIGNED_ARTIFACT_INTEGRITY_INVALID,
      "canonical_unsigned_payload_sha256 does not match typed-data core",
    );
  }

  const expiresAt = human.authorization_expires_at;
  if (typeof expiresAt !== "string") {
    fail(BLOCKED_HUMAN_AUTHORIZATION_EXPIRED, "human authorization has no usable expiry");
  }
  const humanExpiryMs = requireFiniteMs(expiresAt, "human_authorization_expires_at");
  const deadlineMs = requireFiniteMs(u.effective_signing_deadline, "effective_signing_deadline");
  const signingTimeMs = requireFiniteMs(u.signing_time, "signing_time");
  const validAfterSec = requireUintSeconds(u.valid_after, "validAfter");
  const validBeforeSec = requireUintSeconds(u.valid_before, "validBefore");
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    fail(BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID, "injected now is not a usable timestamp");
  }
  const nowSec = Math.floor(nowMs / 1000);

  // Structural temporal relationships (no extension, no refresh).
  if (!(validAfterSec < validBeforeSec)) {
    fail(BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID, "validAfter must precede validBefore");
  }
  if (!(deadlineMs <= humanExpiryMs)) {
    fail(
      BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
      "effective_signing_deadline must not exceed human_authorization_expires_at",
    );
  }
  const deadlineSec = Math.floor(deadlineMs / 1000);
  // validBefore is the EIP-3009 second encoding of the effective signing deadline.
  if (validBeforeSec !== deadlineSec) {
    fail(
      BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
      "validBefore must equal effective_signing_deadline as unix seconds",
    );
  }
  const expectedValidAfter = Math.floor(signingTimeMs / 1000) - BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS;
  if (validAfterSec !== expectedValidAfter) {
    fail(
      BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
      `validAfter must equal signing_time seconds minus ${BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS}s skew`,
    );
  }

  // Current-time gates: equality is BLOCK.
  if (!(nowMs < humanExpiryMs)) {
    fail(
      BLOCKED_HUMAN_AUTHORIZATION_EXPIRED,
      `human authorization expired at ${expiresAt}`,
    );
  }
  if (!(nowMs < deadlineMs)) {
    fail(
      BLOCKED_PAYMENT_REQUIREMENTS_STALE,
      `effective signing deadline ${u.effective_signing_deadline} has passed`,
    );
  }
  if (!(nowSec < validBeforeSec)) {
    fail(
      BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
      `validBefore ${u.valid_before} is not strictly after current unix seconds ${nowSec}`,
    );
  }

  return {
    ok: true,
    unsigned_artifact_sha256: unsignedHash,
    human_authorization_sha256: humanHash,
    now_unix_seconds: nowSec,
    valid_before_unix_seconds: validBeforeSec,
    effective_signing_deadline: u.effective_signing_deadline,
    human_authorization_expires_at: expiresAt,
  };
}
