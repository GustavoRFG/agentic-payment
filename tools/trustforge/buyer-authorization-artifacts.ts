/**
 * buyer-authorization-artifacts — write-once, atomic persistence for one attempt.
 *
 * The unsigned payload reaches disk before a signer is called. That ordering is
 * the crash-safety property: if the process dies mid-attempt there is always a
 * record of what was about to be signed, and never a signature whose attempt was
 * never written down.
 *
 * Writes go to a temporary file, are flushed where the platform supports it, and
 * are published with COPYFILE_EXCL (exclusive create of the destination). On
 * Windows, rename would overwrite an existing destination; exclusive copy refuses
 * that, so write-once does not depend on a TOCTOU existsSync check alone.
 */

import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { canonicalJson, canonicalJsonSha256 } from "./x402-seller-requirements-binding";
import type {
  SignedBuyerAuthorization,
  UnsignedBuyerAuthorization,
} from "./buyer-eip3009-authorization";
import type { BuyerAuthorizationState } from "./buyer-authorization-state-machine";

export const BUYER_AUTHORIZATION_ARTIFACT_SCHEMA_VERSION =
  "trustforge_buyer_authorization_artifact_v0.1.0" as const;

export const BLOCKED_BUYER_ARTIFACT_OVERWRITE = "BLOCKED_BUYER_ARTIFACT_OVERWRITE" as const;
export const BLOCKED_BUYER_ARTIFACT_ORDER = "BLOCKED_BUYER_ARTIFACT_ORDER" as const;

export const ATTEMPT_ARTIFACT = "buyer_authorization_attempt.json" as const;
export const UNSIGNED_ARTIFACT = "buyer_authorization_unsigned.json" as const;
export const SIGNED_ARTIFACT = "buyer_authorization_signed.json" as const;

export interface ArtifactProvenance {
  readonly schema_version: typeof BUYER_AUTHORIZATION_ARTIFACT_SCHEMA_VERSION;
  readonly run_id: string;
  readonly attempt_id: string;
  readonly commit_sha: string | null;
  readonly created_at: string;
}

/** Atomic, exclusive, hashed. Refuses to replace an artifact that already exists. */
export function writeArtifactOnce(path: string, value: unknown): {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
} {
  if (existsSync(path)) {
    throw new Error(
      `${BLOCKED_BUYER_ARTIFACT_OVERWRITE}: ${path} already exists and buyer authorization artifacts are write-once`,
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const body = `${canonicalJson(value)}\n`;
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  let handle: number | null = null;
  try {
    handle = openSync(temporary, "wx");
    writeSync(handle, body, 0, "utf8");
    try {
      fsyncSync(handle);
    } catch {
      // flushing is best-effort on platforms that reject it for this fd type
    }
    closeSync(handle);
    handle = null;
    try {
      // Exclusive create of the final name. Unlike rename on Windows, this fails
      // if the destination already exists instead of silently replacing it.
      copyFileSync(temporary, path, constants.COPYFILE_EXCL);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as { code?: unknown }).code)
          : null;
      if (code === "EEXIST" || existsSync(path)) {
        throw new Error(
          `${BLOCKED_BUYER_ARTIFACT_OVERWRITE}: ${path} already exists and buyer authorization artifacts are write-once`,
        );
      }
      throw error;
    }
    unlinkSync(temporary);
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle);
      } catch {
        /* already closed */
      }
    }
    if (existsSync(temporary)) {
      try {
        unlinkSync(temporary);
      } catch {
        /* leave the temporary file rather than mask the original error */
      }
    }
  }
  return {
    path,
    sha256: canonicalJsonSha256(value),
    bytes: Buffer.byteLength(body, "utf8"),
  };
}

export interface AttemptArtifactInput extends ArtifactProvenance {
  readonly state: Extract<BuyerAuthorizationState, "RESERVED">;
  readonly reserved_at: string;
  readonly endpoint: string;
  readonly method: string;
  readonly max_payment_attempts: number;
  readonly allow_retry: false;
}

export function persistAttemptArtifact(directory: string, input: AttemptArtifactInput) {
  return writeArtifactOnce(join(directory, ATTEMPT_ARTIFACT), input);
}

export interface UnsignedArtifact extends ArtifactProvenance {
  readonly state: Extract<BuyerAuthorizationState, "UNSIGNED_PERSISTED">;
  readonly signing_time: string;
  readonly human_authorization_sha256: string;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly request_binding_sha256: string;
  readonly endpoint: string;
  readonly method: string;
  readonly protocol_version: 1 | 2;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  readonly chain_id: number;
  readonly asset: string;
  readonly pay_to: string;
  readonly seller_amount_atomic: string;
  readonly maximum_authorized_amount_atomic: string;
  readonly buyer_wallet: string;
  readonly paytime_requirements_observed_at: string;
  readonly effective_signing_deadline: string;
  readonly valid_after: string;
  readonly valid_before: string;
  readonly nonce: string;
  readonly domain: UnsignedBuyerAuthorization["domain"];
  readonly domain_provenance: UnsignedBuyerAuthorization["domain_provenance"];
  readonly types: UnsignedBuyerAuthorization["types"];
  readonly primary_type: UnsignedBuyerAuthorization["primary_type"];
  readonly message: UnsignedBuyerAuthorization["message"];
  readonly canonical_unsigned_payload_sha256: string;
}

export function persistUnsignedArtifact(directory: string, artifact: UnsignedArtifact) {
  return writeArtifactOnce(join(directory, UNSIGNED_ARTIFACT), artifact);
}

export interface SignedArtifact extends ArtifactProvenance {
  readonly state: Extract<BuyerAuthorizationState, "SIGNED_PERSISTED">;
  readonly unsigned_artifact_path: string;
  readonly unsigned_artifact_sha256: string;
  readonly unsigned_payload_sha256: string;
  readonly signer_address: string;
  readonly signature: string;
  readonly signature_encoding: SignedBuyerAuthorization["signature_encoding"];
  readonly canonical_signed_payload_sha256: string;
  readonly signed_at: string;
  readonly payment_header_created: false;
  readonly payment_bearing_request_count: 0;
  readonly sent: false;
  readonly retry_allowed: false;
}

export function persistSignedArtifact(directory: string, artifact: SignedArtifact) {
  const unsignedPath = join(directory, UNSIGNED_ARTIFACT);
  if (!existsSync(unsignedPath)) {
    throw new Error(
      `${BLOCKED_BUYER_ARTIFACT_ORDER}: refusing to persist a signature before the unsigned payload exists at ${unsignedPath}`,
    );
  }
  return writeArtifactOnce(join(directory, SIGNED_ARTIFACT), artifact);
}

/** Written when an attempt ends after signing without a send. */
export interface AbandonedArtifact extends ArtifactProvenance {
  readonly state: Extract<BuyerAuthorizationState, "TERMINAL_ABANDONED_REAUTHORIZE">;
  readonly abandoned_at: string;
  readonly reason: string;
  readonly signature_reusable: false;
  readonly resumable_for_send: false;
  readonly requires_reauthorization: true;
}

export function persistAbandonedArtifact(directory: string, artifact: AbandonedArtifact) {
  return writeArtifactOnce(join(directory, "buyer_authorization_abandoned.json"), artifact);
}
