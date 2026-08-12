/**
 * buyer-post-sign-jit-audit — deterministic post-sign audit inside the JIT window.
 *
 * Equivalent to the accepted external first-real-signed-artifact audit checks,
 * but runs immediately after signature without a human round-trip.
 * Synthetic or real signatures: recovery uses persisted typed data + signature.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { recoverTypedDataAddress } from "viem";

import {
  BLOCKED_B37_POST_SIGN_AUDIT_FAILED_NO_PAYMENT,
  POST_SIGN_JIT_AUDIT_PASS,
} from "./b37-execution-gates";
import {
  SIGNED_ARTIFACT,
  UNSIGNED_ARTIFACT,
  type SignedArtifact,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import { canonicalJson, canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export interface PostSignJitAuditInput {
  readonly directory: string;
  readonly expectedBuyer: string;
  readonly expectedAmountAtomic: string;
  readonly expectedAsset: string;
  readonly expectedPayTo: string;
  readonly expectedNetworkCaip2: string;
  readonly expectedRequestBindingSha256: string;
  readonly expectedRequirementsSha256: string;
  readonly expectedEnvelopeSha256: string;
  readonly now: Date;
  /** When true, skip viem recovery (tests may inject recovered address). */
  readonly recoveredSignerOverride?: string;
}

export interface PostSignJitAuditResult {
  readonly result: typeof POST_SIGN_JIT_AUDIT_PASS;
  readonly recovered_signer: string;
  readonly unsigned_artifact_sha256: string;
  readonly signed_artifact_sha256: string;
  readonly valid_before: string;
  readonly signed_at: string;
  readonly checked: readonly string[];
}

function fail(detail: string): never {
  throw new Error(`${BLOCKED_B37_POST_SIGN_AUDIT_FAILED_NO_PAYMENT}: ${detail}`);
}

function lower(a: string): string {
  return a.toLowerCase();
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalArtifactSha256(value: unknown): string {
  return canonicalJsonSha256(value);
}

export async function runPostSignJitAudit(
  input: PostSignJitAuditInput,
): Promise<PostSignJitAuditResult> {
  const checked: string[] = [];
  const check = (label: string, ok: boolean, detail?: string) => {
    checked.push(label);
    if (!ok) fail(detail ?? `${label} failed`);
  };

  const unsignedPath = join(input.directory, UNSIGNED_ARTIFACT);
  const signedPath = join(input.directory, SIGNED_ARTIFACT);
  const unsigned = JSON.parse(readFileSync(unsignedPath, "utf8")) as UnsignedArtifact;
  const signed = JSON.parse(readFileSync(signedPath, "utf8")) as SignedArtifact;

  const unsignedCanonicalSha = canonicalArtifactSha256(unsigned);
  const signedFileSha = fileSha256(signedPath);

  check(
    "unsigned_signed_link",
    signed.unsigned_artifact_sha256 === unsignedCanonicalSha &&
      signed.unsigned_payload_sha256 === unsigned.canonical_unsigned_payload_sha256,
  );
  check(
    "payload_hash",
    unsigned.canonical_unsigned_payload_sha256 ===
      canonicalJsonSha256({
        domain: unsigned.domain,
        types: unsigned.types,
        primary_type: unsigned.primary_type,
        message: unsigned.message,
      }),
  );
  check(
    "signed_core_hash",
    signed.canonical_signed_payload_sha256 ===
      canonicalJsonSha256({
        unsigned_payload_sha256: signed.unsigned_payload_sha256,
        signer_address: signed.signer_address,
        signature: signed.signature,
      }),
  );
  check("sent_false", signed.sent === false);
  check("payment_header_false", signed.payment_header_created === false);
  check("payment_request_count_zero", signed.payment_bearing_request_count === 0);
  check("retry_false", signed.retry_allowed === false);
  check("state_signed", signed.state === "SIGNED_PERSISTED");

  check("amount", String(unsigned.message.value) === input.expectedAmountAtomic);
  check("amount_le_max", BigInt(unsigned.message.value) <= BigInt(unsigned.maximum_authorized_amount_atomic));
  check("asset", lower(unsigned.asset) === lower(input.expectedAsset));
  check("pay_to", lower(unsigned.pay_to) === lower(input.expectedPayTo));
  check("message_to", lower(unsigned.message.to) === lower(input.expectedPayTo));
  check("network", unsigned.canonical_network_caip2 === input.expectedNetworkCaip2);
  check("request_binding", unsigned.request_binding_sha256 === input.expectedRequestBindingSha256);
  check(
    "requirements",
    unsigned.canonical_requirements_sha256 === input.expectedRequirementsSha256,
  );
  check("envelope", unsigned.canonical_envelope_sha256 === input.expectedEnvelopeSha256);
  check("buyer_from", lower(unsigned.message.from) === lower(input.expectedBuyer));

  const validAfter = Number(unsigned.message.validAfter);
  const validBefore = Number(unsigned.message.validBefore);
  const signedAtMs = Date.parse(signed.signed_at);
  const signedAtSec = Math.floor(signedAtMs / 1000);
  check("historical_validAfter", signedAtSec >= validAfter);
  check("historical_validBefore", signedAtSec < validBefore);
  check("now_lt_validBefore", Math.floor(input.now.getTime() / 1000) < validBefore);
  check(
    "now_lt_effective_deadline",
    input.now.getTime() < Date.parse(unsigned.effective_signing_deadline),
  );

  let recovered: string;
  if (input.recoveredSignerOverride) {
    recovered = input.recoveredSignerOverride;
  } else {
    recovered = await recoverTypedDataAddress({
      domain: {
        name: unsigned.domain.name,
        version: unsigned.domain.version,
        chainId: BigInt(unsigned.domain.chainId),
        verifyingContract: unsigned.domain.verifyingContract as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: unsigned.types.TransferWithAuthorization,
      },
      primaryType: "TransferWithAuthorization",
      message: {
        from: unsigned.message.from as `0x${string}`,
        to: unsigned.message.to as `0x${string}`,
        value: BigInt(unsigned.message.value),
        validAfter: BigInt(unsigned.message.validAfter),
        validBefore: BigInt(unsigned.message.validBefore),
        nonce: unsigned.message.nonce as `0x${string}`,
      },
      signature: signed.signature as `0x${string}`,
    });
  }
  check("signer_recovery", lower(recovered) === lower(input.expectedBuyer));
  check("signer_persisted", lower(signed.signer_address) === lower(input.expectedBuyer));

  // Ensure write-once body still matches canonicalJson+\n shape.
  check(
    "unsigned_file_shape",
    fileSha256(unsignedPath) ===
      createHash("sha256").update(`${canonicalJson(unsigned)}\n`).digest("hex"),
  );

  return {
    result: POST_SIGN_JIT_AUDIT_PASS,
    recovered_signer: recovered,
    unsigned_artifact_sha256: unsignedCanonicalSha,
    signed_artifact_sha256: signedFileSha,
    valid_before: String(unsigned.message.validBefore),
    signed_at: signed.signed_at,
    checked,
  };
}
