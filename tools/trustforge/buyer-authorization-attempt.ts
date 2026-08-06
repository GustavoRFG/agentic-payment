/**
 * buyer-authorization-attempt — attempt identity and the buyer nonce.
 *
 * One attempt owns exactly one nonce. The nonce is 32 cryptographic bytes and
 * nothing derived: a nonce from a timestamp, a counter, the endpoint, or the
 * seller's own Tempo id is guessable or collidable, and an EIP-3009 nonce that
 * repeats is a replay. Abandoning an attempt still burns its nonce locally, so a
 * retry can never quietly reuse one.
 *
 * The nonce source is injected so tests can be deterministic without the
 * production path ever having a deterministic option.
 */

import { randomBytes } from "node:crypto";

export const BUYER_NONCE_BYTE_LENGTH = 32 as const;
export const BUYER_NONCE_POLICY = "CSPRNG_32_BYTES_PER_ATTEMPT_NEVER_REUSED" as const;

export const BLOCKED_BUYER_NONCE_INVALID = "BLOCKED_BUYER_NONCE_INVALID" as const;
export const BLOCKED_BUYER_NONCE_REUSED = "BLOCKED_BUYER_NONCE_REUSED" as const;
export const BLOCKED_BUYER_ATTEMPT_DUPLICATE = "BLOCKED_BUYER_ATTEMPT_DUPLICATE" as const;
export const BLOCKED_BUYER_ATTEMPT_LIMIT_EXCEEDED =
  "BLOCKED_BUYER_ATTEMPT_LIMIT_EXCEEDED" as const;

/** 0x + 64 lowercase hex. */
const NONCE_SHAPE = /^0x[0-9a-f]{64}$/;

export type BuyerNonceSource = () => string;

/** The only production nonce source. */
export const cryptoBuyerNonceSource: BuyerNonceSource = () =>
  `0x${randomBytes(BUYER_NONCE_BYTE_LENGTH).toString("hex")}`;

export function assertCanonicalBuyerNonce(nonce: string): string {
  if (typeof nonce !== "string" || !NONCE_SHAPE.test(nonce)) {
    throw new Error(
      `${BLOCKED_BUYER_NONCE_INVALID}: buyer nonce must be 0x followed by 64 lowercase hex characters (32 bytes)`,
    );
  }
  return nonce;
}

export interface ReservedAttempt {
  readonly attempt_id: string;
  readonly run_id: string;
  readonly reserved_at: string;
  readonly nonce: string;
  readonly state: "RESERVED";
}

/**
 * Local record of which attempt ids and nonces have been used. Consumed nonces
 * are never released, including for attempts that were abandoned.
 */
export class BuyerAttemptRegistry {
  private readonly attempts = new Map<string, string>();
  private readonly consumedNonces = new Set<string>();

  constructor(
    private readonly maxAttempts: number,
    seed?: { readonly attemptIds?: readonly string[]; readonly nonces?: readonly string[] },
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error(
        `${BLOCKED_BUYER_ATTEMPT_LIMIT_EXCEEDED}: max_payment_attempts must be a positive integer`,
      );
    }
    for (const id of seed?.attemptIds ?? []) this.attempts.set(id, "");
    for (const nonce of seed?.nonces ?? []) this.consumedNonces.add(nonce);
  }

  get attemptCount(): number {
    return this.attempts.size;
  }

  hasAttempt(attemptId: string): boolean {
    return this.attempts.has(attemptId);
  }

  hasConsumedNonce(nonce: string): boolean {
    return this.consumedNonces.has(nonce);
  }

  nonceFor(attemptId: string): string | undefined {
    const value = this.attempts.get(attemptId);
    return value ? value : undefined;
  }

  /**
   * Reserve the attempt first, then draw the nonce. Reserving second would let a
   * nonce exist that no attempt owns.
   */
  reserve(input: {
    readonly attemptId: string;
    readonly runId: string;
    readonly nonceSource: BuyerNonceSource;
    readonly now: Date;
  }): ReservedAttempt {
    if (this.attempts.has(input.attemptId)) {
      throw new Error(
        `${BLOCKED_BUYER_ATTEMPT_DUPLICATE}: attempt ${input.attemptId} is already reserved`,
      );
    }
    if (this.attempts.size >= this.maxAttempts) {
      throw new Error(
        `${BLOCKED_BUYER_ATTEMPT_LIMIT_EXCEEDED}: ${this.attempts.size} attempt(s) already reserved and max_payment_attempts is ${this.maxAttempts}`,
      );
    }
    const nonce = assertCanonicalBuyerNonce(input.nonceSource());
    if (this.consumedNonces.has(nonce)) {
      throw new Error(
        `${BLOCKED_BUYER_NONCE_REUSED}: this buyer nonce has already been consumed locally`,
      );
    }
    this.consumedNonces.add(nonce);
    this.attempts.set(input.attemptId, nonce);
    return {
      attempt_id: input.attemptId,
      run_id: input.runId,
      reserved_at: input.now.toISOString(),
      nonce,
      state: "RESERVED",
    };
  }

  /** Abandoning does not release the nonce. */
  abandon(attemptId: string): void {
    if (!this.attempts.has(attemptId)) {
      throw new Error(
        `${BLOCKED_BUYER_ATTEMPT_DUPLICATE}: attempt ${attemptId} was never reserved`,
      );
    }
  }

  snapshot(): {
    readonly attempt_ids: readonly string[];
    readonly consumed_nonce_count: number;
  } {
    return {
      attempt_ids: [...this.attempts.keys()].sort(),
      consumed_nonce_count: this.consumedNonces.size,
    };
  }
}

/** Redaction helper: a nonce must never reach an ordinary log line. */
export function redactNonce(nonce: string): string {
  return NONCE_SHAPE.test(nonce) ? `0x…${nonce.slice(-4)}` : "0x…";
}

// ---------------------------------------------------------------- pipeline
import {
  buildUnsignedBuyerAuthorization,
  resolveEip3009Domain,
  signUnsignedAuthorization,
  validateFreshAuthorizedRequirements,
  type InjectedTypedDataSigner,
  type PreparedAuthorizationInput,
} from "./buyer-eip3009-authorization";
import {
  persistAbandonedArtifact,
  persistAttemptArtifact,
  persistSignedArtifact,
  persistUnsignedArtifact,
  UNSIGNED_ARTIFACT,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import {
  assertLegalTransition,
  assertReachableInB2,
  terminalStateForUnsentAttempt,
  type BuyerAuthorizationState,
} from "./buyer-authorization-state-machine";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";
import { canonicalCaip2ChainId } from "./x402-network-identity";

export interface BuyerAuthorizationPipelineResult {
  readonly attempt_id: string;
  readonly state: Extract<BuyerAuthorizationState, "TERMINAL_ABANDONED_REAUTHORIZE">;
  readonly signed_state_reached: Extract<BuyerAuthorizationState, "SIGNED_PERSISTED">;
  readonly unsigned_artifact_sha256: string;
  readonly signed_artifact_sha256: string;
  readonly abandoned_artifact_sha256: string;
  readonly canonical_unsigned_payload_sha256: string;
  readonly canonical_signed_payload_sha256: string;
  readonly sent: false;
  readonly payment_header_created: false;
  readonly payment_bearing_request_count: 0;
  readonly retry_allowed: false;
  readonly resumable_for_send: false;
}

/**
 * validate -> reserve -> nonce -> build -> persist unsigned -> sign ->
 * persist signed -> abandon (no send).
 *
 * Binding mismatches are checked before the nonce source is touched. The signer
 * is only reached after the unsigned artifact is on disk. B.2 has no send path,
 * so a successful run always ends TERMINAL_ABANDONED_REAUTHORIZE: the signature
 * exists on disk and may never be resumed.
 */
export async function runBuyerAuthorizationPipeline(input: {
  readonly directory: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly commitSha: string | null;
  readonly registry: BuyerAttemptRegistry;
  readonly nonceSource: BuyerNonceSource;
  readonly signer: InjectedTypedDataSigner;
  readonly now: Date;
  readonly prepared: Omit<PreparedAuthorizationInput, "nonce">;
}): Promise<BuyerAuthorizationPipelineResult> {
  // Fail closed before any attempt reservation or nonce draw.
  validateFreshAuthorizedRequirements(input.prepared);
  resolveEip3009Domain({
    observation: input.prepared.paytimeObservation,
    authorizedAsset: input.prepared.paytimeObservation.binding.asset,
  });

  let state: BuyerAuthorizationState = "RESERVED";
  const reserved = input.registry.reserve({
    attemptId: input.attemptId,
    runId: input.runId,
    nonceSource: input.nonceSource,
    now: input.now,
  });
  assertReachableInB2(state);

  const binding = input.prepared.paytimeObservation.binding;
  const provenance = {
    schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
    run_id: input.runId,
    attempt_id: input.attemptId,
    commit_sha: input.commitSha,
    created_at: input.now.toISOString(),
  } as const;

  persistAttemptArtifact(input.directory, {
    ...provenance,
    state: "RESERVED",
    reserved_at: reserved.reserved_at,
    endpoint: input.prepared.authorizedEndpoint,
    method: input.prepared.authorizedMethod,
    max_payment_attempts: 1,
    allow_retry: false,
  });

  const unsigned = buildUnsignedBuyerAuthorization({ ...input.prepared, nonce: reserved.nonce });

  const unsignedArtifact: UnsignedArtifact = {
    ...provenance,
    state: "UNSIGNED_PERSISTED",
    signing_time: unsigned.signing_time,
    human_authorization_sha256: canonicalJsonSha256(input.prepared.humanAuthorization),
    canonical_requirements_sha256: binding.canonical_requirements_sha256,
    canonical_envelope_sha256: binding.canonical_envelope_sha256,
    request_binding_sha256: binding.request_binding_sha256,
    endpoint: input.prepared.authorizedEndpoint,
    method: input.prepared.authorizedMethod,
    protocol_version: binding.protocol_version,
    seller_network_raw: binding.seller_network_raw,
    canonical_network_caip2: binding.canonical_network_caip2,
    chain_id: canonicalCaip2ChainId(binding.canonical_network_caip2),
    asset: binding.asset,
    pay_to: binding.pay_to,
    seller_amount_atomic: unsigned.seller_amount_atomic,
    maximum_authorized_amount_atomic: unsigned.maximum_authorized_amount_atomic,
    buyer_wallet: unsigned.message.from,
    paytime_requirements_observed_at:
      input.prepared.paytimeObservation.requirements_observed_at,
    effective_signing_deadline: unsigned.effective_signing_deadline,
    valid_after: unsigned.message.validAfter,
    valid_before: unsigned.message.validBefore,
    nonce: unsigned.message.nonce,
    domain: unsigned.domain,
    domain_provenance: unsigned.domain_provenance,
    types: unsigned.types,
    primary_type: unsigned.primary_type,
    message: unsigned.message,
    canonical_unsigned_payload_sha256: unsigned.canonical_unsigned_payload_sha256,
  };

  assertLegalTransition(state, "UNSIGNED_PERSISTED");
  const unsignedWrite = persistUnsignedArtifact(input.directory, unsignedArtifact);
  state = "UNSIGNED_PERSISTED";

  // only now may a signer be involved
  const signed = await signUnsignedAuthorization({
    unsigned,
    signer: input.signer,
    now: input.now,
  });

  assertLegalTransition(state, "SIGNED_PERSISTED");
  const signedWrite = persistSignedArtifact(input.directory, {
    ...provenance,
    state: "SIGNED_PERSISTED",
    unsigned_artifact_path: UNSIGNED_ARTIFACT,
    unsigned_artifact_sha256: unsignedWrite.sha256,
    unsigned_payload_sha256: signed.unsigned_payload_sha256,
    signer_address: signed.signer_address,
    signature: signed.signature,
    signature_encoding: signed.signature_encoding,
    canonical_signed_payload_sha256: signed.canonical_signed_payload_sha256,
    signed_at: signed.signed_at,
    payment_header_created: false,
    payment_bearing_request_count: 0,
    sent: false,
    retry_allowed: false,
  });
  state = "SIGNED_PERSISTED";

  // B.2 has no send. Closing without send abandons: signature is not resumable.
  const abandonedState = terminalStateForUnsentAttempt(state);
  assertLegalTransition(state, abandonedState);
  assertReachableInB2(abandonedState);
  input.registry.abandon(input.attemptId);
  const abandonedWrite = persistAbandonedArtifact(input.directory, {
    ...provenance,
    state: "TERMINAL_ABANDONED_REAUTHORIZE",
    abandoned_at: input.now.toISOString(),
    reason: "B2_SIGNED_NOT_SENT_NO_PAYMENT_BEARING_SEND",
    signature_reusable: false,
    resumable_for_send: false,
    requires_reauthorization: true,
  });
  state = "TERMINAL_ABANDONED_REAUTHORIZE";

  return {
    attempt_id: input.attemptId,
    state,
    signed_state_reached: "SIGNED_PERSISTED",
    unsigned_artifact_sha256: unsignedWrite.sha256,
    signed_artifact_sha256: signedWrite.sha256,
    abandoned_artifact_sha256: abandonedWrite.sha256,
    canonical_unsigned_payload_sha256: unsigned.canonical_unsigned_payload_sha256,
    canonical_signed_payload_sha256: signed.canonical_signed_payload_sha256,
    sent: false,
    payment_header_created: false,
    payment_bearing_request_count: 0,
    retry_allowed: false,
    resumable_for_send: false,
  };
}
