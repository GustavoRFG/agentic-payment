/**
 * buyer-eip3009-authorization — build the exact typed data that will be signed.
 *
 * The domain is not invented here. It mirrors the construction the installed
 * @x402/evm exact-scheme client performs, including its refusal to guess: that
 * client throws when `extra.name` or `extra.version` is absent, and so does this,
 * because a token domain guessed wrong produces a signature that verifies against
 * nothing or, worse, against something else.
 *
 * This module never sees a private key. It takes a buyer address and produces
 * unsigned typed data; signing is a separate call that takes an injected signer.
 */

import {
  BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
  BLOCKED_PAYMENT_REQUIREMENTS_STALE,
  BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
  calculateEffectiveSigningDeadline,
  canonicalJson,
  canonicalJsonSha256,
  validateFutureBuyerValidBefore,
  type SellerRequirementsObservation,
} from "./x402-seller-requirements-binding";
import {
  assertX402NetworkMatchesCanonical,
  canonicalCaip2ChainId,
} from "./x402-network-identity";
import { assertCanonicalBuyerNonce } from "./buyer-authorization-attempt";
import type { UnsignedArtifact } from "./buyer-authorization-artifacts";
import {
  validateBuyerAuthorizationBeforeSigning,
  type PreSignAttemptArtifact,
} from "./buyer-pre-sign-validation";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";

export const BLOCKED_BUYER_EIP3009_DOMAIN_UNRESOLVED =
  "BLOCKED_BUYER_EIP3009_DOMAIN_UNRESOLVED" as const;
export const BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH =
  "BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH" as const;
export const BLOCKED_HUMAN_AUTHORIZATION_EXPIRED =
  "BLOCKED_HUMAN_AUTHORIZATION_EXPIRED" as const;
export const BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH =
  "BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH" as const;

export const EIP3009_PRIMARY_TYPE = "TransferWithAuthorization" as const;

/** Exactly the field list the installed @x402/evm client signs. */
export const EIP3009_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: string;
}

export interface DomainProvenance {
  readonly name_source: "seller_requirements.extra.name";
  readonly version_source: "seller_requirements.extra.version";
  readonly chain_id_source: "canonical_network_caip2";
  readonly verifying_contract_source: "authorized_asset";
  readonly fallback_used: false;
}

export interface Eip3009Message {
  readonly from: string;
  readonly to: string;
  readonly value: string;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly nonce: string;
}

export interface UnsignedBuyerAuthorization {
  readonly domain: Eip712Domain;
  readonly domain_provenance: DomainProvenance;
  readonly types: typeof EIP3009_AUTHORIZATION_TYPES;
  readonly primary_type: typeof EIP3009_PRIMARY_TYPE;
  readonly message: Eip3009Message;
  readonly signing_time: string;
  readonly effective_signing_deadline: string;
  readonly seller_amount_atomic: string;
  readonly maximum_authorized_amount_atomic: string;
  readonly canonical_unsigned_payload_sha256: string;
}

function requireAddress(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: ${label} is not a 20-byte address`,
    );
  }
  return value;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Resolve the token domain, or refuse. No default name, no default version.
 */
export function resolveEip3009Domain(input: {
  readonly observation: SellerRequirementsObservation;
  readonly authorizedAsset: string;
}): { readonly domain: Eip712Domain; readonly provenance: DomainProvenance } {
  const binding = input.observation.binding;
  const extra = binding.extra;
  const record = (extra && typeof extra === "object" && !Array.isArray(extra)
    ? (extra as Record<string, unknown>)
    : null);
  const name = record?.name;
  const version = record?.version;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(
      `${BLOCKED_BUYER_EIP3009_DOMAIN_UNRESOLVED}: seller requirements carry no EIP-712 domain name for asset ${binding.asset}`,
    );
  }
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(
      `${BLOCKED_BUYER_EIP3009_DOMAIN_UNRESOLVED}: seller requirements carry no EIP-712 domain version for asset ${binding.asset}`,
    );
  }
  if (!sameAddress(binding.asset, input.authorizedAsset)) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: pay-time asset ${binding.asset} is not the authorized asset ${input.authorizedAsset}`,
    );
  }
  // chain id comes from our canonical network identity, not from the raw string
  assertX402NetworkMatchesCanonical({
    protocolVersion: binding.protocol_version,
    sellerNetworkRaw: binding.seller_network_raw,
    canonicalCaip2: binding.canonical_network_caip2,
  });
  const chainId = canonicalCaip2ChainId(binding.canonical_network_caip2);
  return {
    domain: {
      name,
      version,
      chainId,
      verifyingContract: requireAddress(binding.asset, "asset"),
    },
    provenance: {
      name_source: "seller_requirements.extra.name",
      version_source: "seller_requirements.extra.version",
      chain_id_source: "canonical_network_caip2",
      verifying_contract_source: "authorized_asset",
      fallback_used: false,
    },
  };
}

export interface BuyerAuthorizationValidity {
  readonly validAfter: string;
  readonly validBefore: string;
}

/**
 * validAfter is backdated by the approved skew; validBefore never outlives the
 * smallest of the seller timeout, the local freshness cap and the human
 * authorization. The tightest deadline wins, and none of them is extended here.
 */
export function buildBuyerValidity(input: {
  readonly signingTime: Date;
  readonly effectiveSigningDeadline: string;
  readonly clockSkewSeconds?: number;
}): BuyerAuthorizationValidity {
  const skew = input.clockSkewSeconds ?? BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS;
  const signingSeconds = Math.floor(input.signingTime.getTime() / 1000);
  const deadlineMs = Date.parse(input.effectiveSigningDeadline);
  if (!Number.isFinite(deadlineMs)) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: effective signing deadline invalid`,
    );
  }
  const validAfter = signingSeconds - skew;
  const validBefore = Math.floor(deadlineMs / 1000);
  if (!(validAfter < signingSeconds)) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: validAfter must precede the signing time`,
    );
  }
  if (!(validBefore > signingSeconds)) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: validBefore must be in the future at signing time`,
    );
  }
  const check = validateFutureBuyerValidBefore(validBefore, input.effectiveSigningDeadline);
  if (!check.valid) {
    throw new Error(check.reason ?? BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID);
  }
  return { validAfter: String(validAfter), validBefore: String(validBefore) };
}

export interface PreparedAuthorizationInput {
  /** Already-validated human decision. */
  readonly humanAuthorization: HumanPaymentAuthorization;
  /** Fresh pay-time observation, produced by an injected refresh interface. */
  readonly paytimeObservation: SellerRequirementsObservation;
  /** The hashes the human authorized. */
  readonly authorizedRequirementsSha256: string;
  readonly authorizedEnvelopeSha256: string;
  readonly authorizedRequestBindingSha256: string;
  readonly authorizedEndpoint: string;
  readonly authorizedMethod: string;
  readonly buyerAddress: string;
  readonly signingTime: Date;
  readonly nonce: string;
}

/**
 * Everything that must hold before a nonce is worth spending. Called before the
 * attempt is reserved so a mismatch costs nothing.
 */
export function validateFreshAuthorizedRequirements(
  input: Omit<PreparedAuthorizationInput, "nonce">,
): {
  readonly effective: ReturnType<typeof calculateEffectiveSigningDeadline>;
  readonly sellerAmountAtomic: string;
  readonly maximumAuthorizedAmountAtomic: string;
} {
  const binding = input.paytimeObservation.binding;
  const human = input.humanAuthorization;

  if (binding.request_binding_sha256 !== input.authorizedRequestBindingSha256) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: pay-time request binding does not match the authorized request`,
    );
  }
  if (human.endpoint !== input.authorizedEndpoint) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: endpoint does not match the human authorization`,
    );
  }
  if ((human.method ?? null) !== input.authorizedMethod) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: method does not match the human authorization`,
    );
  }
  assertX402NetworkMatchesCanonical({
    protocolVersion: binding.protocol_version,
    sellerNetworkRaw: binding.seller_network_raw,
    canonicalCaip2: binding.canonical_network_caip2,
  });
  if (human.canonical_network_caip2 && human.canonical_network_caip2 !== binding.canonical_network_caip2) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: canonical network does not match the human authorization`,
    );
  }
  if (human.seller_network_raw && human.seller_network_raw !== binding.seller_network_raw) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: raw seller network does not match the human authorization`,
    );
  }
  if (human.asset && !sameAddress(human.asset, binding.asset)) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: asset does not match the human authorization`,
    );
  }
  if (human.pay_to && !sameAddress(human.pay_to, binding.pay_to)) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: payTo does not match the human authorization`,
    );
  }
  if (binding.canonical_requirements_sha256 !== input.authorizedRequirementsSha256) {
    throw new Error(
      `${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: pay-time requirements hash is not the authorized hash`,
    );
  }
  if (binding.canonical_envelope_sha256 !== input.authorizedEnvelopeSha256) {
    throw new Error(
      `${BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH}: pay-time envelope hash is not the authorized hash`,
    );
  }

  const sellerAmount = binding.amount_atomic;
  const maximum = human.maximum_authorized_amount_atomic ?? human.amount_atomic ?? null;
  if (typeof maximum !== "string" || maximum.length === 0) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: human authorization carries no maximum authorized amount`,
    );
  }
  if (BigInt(sellerAmount) > BigInt(maximum)) {
    throw new Error(
      `${BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH}: seller amount ${sellerAmount} exceeds the maximum authorized ${maximum}`,
    );
  }

  const expiresAt = human.authorization_expires_at;
  if (typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error(
      `${BLOCKED_HUMAN_AUTHORIZATION_EXPIRED}: human authorization has no usable expiry`,
    );
  }
  if (input.signingTime.getTime() >= Date.parse(expiresAt)) {
    throw new Error(
      `${BLOCKED_HUMAN_AUTHORIZATION_EXPIRED}: human authorization expired at ${expiresAt}`,
    );
  }

  const effective = calculateEffectiveSigningDeadline({
    paytimeRequirementsObservedAt: input.paytimeObservation.requirements_observed_at,
    maxTimeoutSeconds: binding.max_timeout_seconds,
    humanAuthorizationExpiresAt: expiresAt,
    now: input.signingTime,
  });
  if (effective.stale) {
    throw new Error(
      `${BLOCKED_PAYMENT_REQUIREMENTS_STALE}: effective signing deadline ${effective.effective_signing_deadline} has passed`,
    );
  }
  return {
    effective,
    sellerAmountAtomic: sellerAmount,
    maximumAuthorizedAmountAtomic: maximum,
  };
}

/**
 * Build the exact unsigned authorization. `value` is the seller amount, never
 * the authorized maximum: signing the ceiling would authorize more than the
 * quote asked for.
 */
export function buildUnsignedBuyerAuthorization(
  input: PreparedAuthorizationInput,
): UnsignedBuyerAuthorization {
  const { effective, sellerAmountAtomic, maximumAuthorizedAmountAtomic } =
    validateFreshAuthorizedRequirements(input);
  const binding = input.paytimeObservation.binding;
  const { domain, provenance } = resolveEip3009Domain({
    observation: input.paytimeObservation,
    authorizedAsset: binding.asset,
  });
  const validity = buildBuyerValidity({
    signingTime: input.signingTime,
    effectiveSigningDeadline: effective.effective_signing_deadline,
  });
  const message: Eip3009Message = {
    from: requireAddress(input.buyerAddress, "buyer address"),
    to: requireAddress(binding.pay_to, "payTo"),
    value: sellerAmountAtomic,
    validAfter: validity.validAfter,
    validBefore: validity.validBefore,
    nonce: assertCanonicalBuyerNonce(input.nonce),
  };
  const core = {
    domain,
    types: EIP3009_AUTHORIZATION_TYPES,
    primary_type: EIP3009_PRIMARY_TYPE,
    message,
  };
  return {
    ...core,
    domain_provenance: provenance,
    signing_time: input.signingTime.toISOString(),
    effective_signing_deadline: effective.effective_signing_deadline,
    seller_amount_atomic: sellerAmountAtomic,
    maximum_authorized_amount_atomic: maximumAuthorizedAmountAtomic,
    canonical_unsigned_payload_sha256: canonicalJsonSha256(core),
  };
}

/** The signer seam. A private key never crosses this boundary from our side. */
export interface InjectedTypedDataSigner {
  readonly address: string;
  signTypedData(input: {
    readonly domain: Eip712Domain;
    readonly types: typeof EIP3009_AUTHORIZATION_TYPES;
    readonly primaryType: typeof EIP3009_PRIMARY_TYPE;
    readonly message: Eip3009Message;
  }): Promise<string>;
}

export const BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH =
  "BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH" as const;

export interface SignedBuyerAuthorization {
  readonly signature: string;
  readonly signature_encoding: "eip712-65-byte-hex";
  readonly signer_address: string;
  readonly unsigned_payload_sha256: string;
  readonly canonical_signed_payload_sha256: string;
  readonly signed_at: string;
}

/**
 * The only productive signing entry point. Pre-sign validation is mandatory and
 * cannot be skipped: there is no overload that accepts only an unsigned payload
 * plus a signer. UNSIGNED_PERSISTED alone never implies SIGNABLE.
 */
export async function signUnsignedAuthorization(input: {
  readonly unsignedArtifact: UnsignedArtifact;
  readonly attempt: PreSignAttemptArtifact;
  readonly humanAuthorization: HumanPaymentAuthorization;
  readonly now: Date;
  readonly signer: InjectedTypedDataSigner;
  readonly expectedUnsignedHash?: string | null;
}): Promise<SignedBuyerAuthorization> {
  validateBuyerAuthorizationBeforeSigning({
    unsignedArtifact: input.unsignedArtifact,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
    now: input.now,
    expectedUnsignedHash: input.expectedUnsignedHash,
  });

  const { unsignedArtifact, signer } = input;
  if (!sameAddress(signer.address, unsignedArtifact.message.from)) {
    throw new Error(
      `${BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH}: signer is not the authorized buyer wallet`,
    );
  }
  // Private to this entry point: no productive export reaches signTypedData without
  // the validation above.
  const signature = await signer.signTypedData({
    domain: unsignedArtifact.domain,
    types: unsignedArtifact.types,
    primaryType: unsignedArtifact.primary_type,
    message: unsignedArtifact.message,
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: signer returned a malformed signature`,
    );
  }
  const core = {
    unsigned_payload_sha256: unsignedArtifact.canonical_unsigned_payload_sha256,
    signer_address: signer.address,
    signature,
  };
  return {
    signature,
    signature_encoding: "eip712-65-byte-hex",
    signer_address: signer.address,
    unsigned_payload_sha256: unsignedArtifact.canonical_unsigned_payload_sha256,
    canonical_signed_payload_sha256: canonicalJsonSha256(core),
    signed_at: input.now.toISOString(),
  };
}

export { canonicalJson, canonicalJsonSha256 };
