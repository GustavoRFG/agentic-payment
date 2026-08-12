/**
 * buyer-payment-header-from-signed-artifact — reconstruct x402 PAYMENT-SIGNATURE
 * exclusively from a persisted signed buyer authorization + bound seller observation.
 *
 * Uses @x402/core encodePaymentSignatureHeader (serialize only).
 * NEVER signs. NEVER uses key-held fetch wrappers or library payload creators.
 */

import { createHash } from "node:crypto";

import { encodePaymentSignatureHeader } from "@x402/core/http";

import {
  BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED,
  GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE,
  GUARD_PRODUCTIVE_SEND_BRIDGE_CANNOT_SIGN,
} from "./b371-execution-gates";
import type { SignedArtifact, UnsignedArtifact } from "./buyer-authorization-artifacts";
import type { SellerRequirementsObservation } from "./x402-seller-requirements-binding";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export const X402_V2_PAYMENT_HEADER_NAME = "PAYMENT-SIGNATURE" as const;

export interface X402ExactPaymentPayloadV2 {
  readonly x402Version: 2;
  readonly resource: unknown;
  readonly accepted: unknown;
  readonly payload: {
    readonly authorization: {
      readonly from: string;
      readonly to: string;
      readonly value: string;
      readonly validAfter: string;
      readonly validBefore: string;
      readonly nonce: string;
    };
    readonly signature: string;
  };
  readonly extensions?: Record<string, unknown> | null;
}

export interface BuiltPaymentHeader {
  readonly header_name: typeof X402_V2_PAYMENT_HEADER_NAME;
  /** Opaque wire value — never log or persist in evidence. */
  readonly header_value: string;
  readonly payload_canonical_sha256: string;
  readonly header_value_sha256: string;
  readonly x402_version: 2;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Structural reminder: this module must never gain signing imports. */
export function assertPaymentHeaderBuilderCannotSign(): void {
  fail(
    GUARD_PRODUCTIVE_SEND_BRIDGE_CANNOT_SIGN,
    "payment header builder consumes persisted signatures only; signing is forbidden here",
  );
}

/**
 * Build the exact PaymentPayloadV2 object from persisted artifacts.
 * Does not encode to header — use encodeX402PaymentSignatureHeaderFromPayload.
 */
export function buildX402ExactPaymentPayloadFromPersistedArtifacts(input: {
  readonly unsignedArtifact: UnsignedArtifact;
  readonly signedArtifact: SignedArtifact;
  readonly sellerObservation: SellerRequirementsObservation;
}): X402ExactPaymentPayloadV2 {
  const u = input.unsignedArtifact;
  const s = input.signedArtifact;
  const obs = input.sellerObservation;

  if (s.state !== "SIGNED_PERSISTED") {
    fail(BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED, "signed artifact state invalid");
  }
  if (typeof s.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(s.signature)) {
    fail(BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED, "signed artifact signature malformed");
  }
  if (s.unsigned_payload_sha256 !== u.canonical_unsigned_payload_sha256) {
    fail(BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED, "signed/unsigned payload hash mismatch");
  }
  if (u.protocol_version !== 2) {
    fail(
      BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED,
      "productive bridge R1 supports x402Version=2 only",
    );
  }
  if (!obs.selected_requirements || !obs.payment_required_envelope) {
    fail(BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED, "seller observation incomplete");
  }
  if (obs.binding.canonical_requirements_sha256 !== u.canonical_requirements_sha256) {
    fail(
      BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED,
      "observation requirements hash != unsigned",
    );
  }
  if (obs.binding.canonical_envelope_sha256 !== u.canonical_envelope_sha256) {
    fail(BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED, "observation envelope hash != unsigned");
  }

  const authorization = {
    from: String(u.message.from),
    to: String(u.message.to),
    value: String(u.message.value),
    validAfter: String(u.message.validAfter),
    validBefore: String(u.message.validBefore),
    nonce: String(u.message.nonce),
  };

  const resource =
    obs.payment_required_envelope.resource ?? obs.binding.resource ?? null;
  if (!resource || typeof resource !== "object") {
    fail(BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED, "seller resource missing");
  }

  return {
    x402Version: 2,
    resource,
    accepted: obs.selected_requirements,
    payload: {
      authorization,
      signature: s.signature,
    },
  };
}

/**
 * Encode PaymentPayload → PAYMENT-SIGNATURE wire value via @x402/core serializer.
 */
export function encodeX402PaymentSignatureHeaderFromPayload(
  payload: X402ExactPaymentPayloadV2,
): BuiltPaymentHeader {
  // Serialize-only library path — no signing.
  const headerValue = encodePaymentSignatureHeader(payload as never);
  if (typeof headerValue !== "string" || headerValue.length === 0) {
    fail(BLOCKED_B371_PAYMENT_HEADER_CONSTRUCTION_FAILED, "encoder returned empty header");
  }
  return {
    header_name: X402_V2_PAYMENT_HEADER_NAME,
    header_value: headerValue,
    payload_canonical_sha256: canonicalJsonSha256(payload),
    header_value_sha256: sha256Utf8(headerValue),
    x402_version: 2,
  };
}

export function buildPaymentHeaderFromPersistedSignedArtifact(input: {
  readonly unsignedArtifact: UnsignedArtifact;
  readonly signedArtifact: SignedArtifact;
  readonly sellerObservation: SellerRequirementsObservation;
}): BuiltPaymentHeader {
  const payload = buildX402ExactPaymentPayloadFromPersistedArtifacts(input);
  return encodeX402PaymentSignatureHeaderFromPayload(payload);
}

/** Evidence-safe view — never includes header value or signature bytes. */
export function sanitizeBuiltPaymentHeaderEvidence(header: BuiltPaymentHeader): {
  readonly header_name: string;
  readonly payload_canonical_sha256: string;
  readonly header_value_sha256: string;
  readonly x402_version: 2;
  readonly header_value: typeof GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE;
} {
  return {
    header_name: header.header_name,
    payload_canonical_sha256: header.payload_canonical_sha256,
    header_value_sha256: header.header_value_sha256,
    x402_version: 2,
    header_value: GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE,
  };
}
