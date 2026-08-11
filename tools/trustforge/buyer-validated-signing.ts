/**
 * buyer-validated-signing — opaque validated object for the production signer.
 *
 * Raw persisted unsigned artifacts cannot construct this type. The only factory
 * runs mandatory pre-sign validation and signing-authorization binding first.
 */

import type { UnsignedArtifact } from "./buyer-authorization-artifacts";
import {
  validateBuyerAuthorizationBeforeSigning,
  type PreSignAttemptArtifact,
  type PreSignValidationResult,
} from "./buyer-pre-sign-validation";
import {
  validateBuyerSigningAuthorization,
  type BuyerSigningAuthorization,
} from "./buyer-signing-authorization";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";
import {
  EIP3009_AUTHORIZATION_TYPES,
  EIP3009_PRIMARY_TYPE,
  type Eip3009Message,
  type Eip712Domain,
} from "./buyer-eip3009-authorization";
import { assertNotHumanOneShotSigningMandate } from "./buyer-one-shot-signing-mandate";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

/** Runtime brand token — only the factory may stamp this field. */
export const VALIDATED_BUYER_AUTHORIZATION_BRAND =
  "ValidatedBuyerAuthorizationForSigning" as const;

export interface ValidatedBuyerTypedData {
  readonly domain: Eip712Domain;
  readonly types: typeof EIP3009_AUTHORIZATION_TYPES;
  readonly primaryType: typeof EIP3009_PRIMARY_TYPE;
  readonly message: Eip3009Message;
}

/**
 * Opaque brand: productive callers cannot forge this without the factory.
 * Contains only data already proven current and authorization-bound.
 */
export interface ValidatedBuyerAuthorizationForSigning {
  readonly __brand: typeof VALIDATED_BUYER_AUTHORIZATION_BRAND;
  readonly typedData: ValidatedBuyerTypedData;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly unsignedArtifactSha256: string;
  readonly prepareAuthorizationSha256: string;
  readonly signingAuthorization: BuyerSigningAuthorization;
  readonly signingAuthorizationSha256: string;
  readonly preSign: PreSignValidationResult;
  readonly attempt: PreSignAttemptArtifact;
  readonly humanAuthorization: HumanPaymentAuthorization;
}

export function prepareValidatedBuyerAuthorizationForSigning(input: {
  readonly unsignedArtifact: UnsignedArtifact;
  readonly attempt: PreSignAttemptArtifact;
  readonly humanAuthorization: HumanPaymentAuthorization;
  readonly signingAuthorization: BuyerSigningAuthorization | null | undefined;
  readonly now: Date;
  readonly expectedUnsignedHash?: string | null;
}): ValidatedBuyerAuthorizationForSigning {
  assertNotHumanOneShotSigningMandate(input.signingAuthorization);
  const preSign = validateBuyerAuthorizationBeforeSigning({
    unsignedArtifact: input.unsignedArtifact,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
    now: input.now,
    expectedUnsignedHash: input.expectedUnsignedHash,
  });
  const prepareAuthorizationSha256 = canonicalJsonSha256(input.humanAuthorization);
  const signingAuthorization = validateBuyerSigningAuthorization({
    authorization: input.signingAuthorization,
    unsignedArtifact: input.unsignedArtifact,
    unsignedArtifactSha256: preSign.unsigned_artifact_sha256,
    prepareAuthorizationSha256,
    now: input.now,
  });
  const u = input.unsignedArtifact;
  const typedData: ValidatedBuyerTypedData = {
    domain: u.domain,
    types: u.types,
    primaryType: u.primary_type,
    message: u.message,
  };
  return Object.freeze({
    __brand: VALIDATED_BUYER_AUTHORIZATION_BRAND,
    typedData,
    unsignedArtifact: u,
    unsignedArtifactSha256: preSign.unsigned_artifact_sha256,
    prepareAuthorizationSha256,
    signingAuthorization,
    signingAuthorizationSha256: canonicalJsonSha256(signingAuthorization),
    preSign,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
  });
}
