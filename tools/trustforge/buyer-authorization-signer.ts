/**
 * buyer-authorization-signer — B.3 validated signer boundary.
 *
 * Signing contract is separate from credential acquisition. Productive credential
 * providers are unauthorized. The only signing path accepts
 * ValidatedBuyerAuthorizationForSigning, consumes a one-shot signature attempt,
 * persists the signed artifact, then hard-stops before send.
 */

import { join } from "node:path";

import {
  BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED,
  BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED,
  BLOCKED_B3_REAL_SIGNING_NOT_ENABLED,
  assertB3PaymentBearingSendNotAuthorized,
  assertB3RealSignerCredentialProviderNotAuthorized,
} from "./b3-execution-gates";
import {
  loadB3SignerActivationPolicy,
  type B3SignerActivationPolicy,
} from "./b3-signer-activation-policy";
import {
  persistSignedArtifact,
  UNSIGNED_ARTIFACT,
  writeArtifactOnce,
  type SignedArtifact,
  type UnsignedArtifact,
} from "./buyer-authorization-artifacts";
import {
  BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID,
  BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH,
  canonicalJsonSha256,
} from "./buyer-eip3009-authorization";
import { BuyerSignatureAttemptLedger } from "./buyer-signature-attempt-ledger";
import type { BuyerSigningAuthorization } from "./buyer-signing-authorization";
import type { PreSignAttemptArtifact } from "./buyer-pre-sign-validation";
import {
  prepareValidatedBuyerAuthorizationForSigning,
  type ValidatedBuyerAuthorizationForSigning,
  type ValidatedBuyerTypedData,
} from "./buyer-validated-signing";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";

export type HexAddress = `0x${string}`;
export type HexSignature = `0x${string}`;

/** Production signing contract. Does not know how credentials are obtained. */
export interface BuyerAuthorizationSigner {
  readonly address: HexAddress;
  signTypedData(request: ValidatedBuyerTypedData): Promise<HexSignature>;
}

/**
 * Future credential acquisition seam. Every productive implementation is blocked.
 */
export interface BuyerCredentialProvider {
  readonly kind: "unauthorized" | "future";
  acquireBuyerSigner(): Promise<BuyerAuthorizationSigner>;
}

export function createUnauthorizedBuyerCredentialProvider(): BuyerCredentialProvider {
  return {
    kind: "unauthorized",
    async acquireBuyerSigner(): Promise<BuyerAuthorizationSigner> {
      assertB3RealSignerCredentialProviderNotAuthorized();
    },
  };
}

/** Adapt a legacy injected fixture signer into the B.3 validated-data contract. */
export function adaptInjectedTypedDataSigner(input: {
  readonly address: string;
  signTypedData(request: {
    readonly domain: ValidatedBuyerTypedData["domain"];
    readonly types: ValidatedBuyerTypedData["types"];
    readonly primaryType: ValidatedBuyerTypedData["primaryType"];
    readonly message: ValidatedBuyerTypedData["message"];
  }): Promise<string>;
}): BuyerAuthorizationSigner {
  return {
    address: requireHexAddress(input.address, "injected signer address"),
    async signTypedData(request: ValidatedBuyerTypedData): Promise<HexSignature> {
      return requireHexSignature(
        await input.signTypedData({
          domain: request.domain,
          types: request.types,
          primaryType: request.primaryType,
          message: request.message,
        }),
      );
    },
  };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function requireHexAddress(value: string, label: string): HexAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      `${BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH}: ${label} is not a 20-byte address`,
    );
  }
  return value as HexAddress;
}

function requireHexSignature(value: string): HexSignature {
  if (!/^0x[0-9a-fA-F]{130}$/.test(value)) {
    throw new Error(
      `${BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID}: signer returned a malformed signature`,
    );
  }
  return value as HexSignature;
}

export interface AuthorizedBuyerSigningInput {
  readonly directory: string;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly attempt: PreSignAttemptArtifact;
  readonly humanAuthorization: HumanPaymentAuthorization;
  readonly signingAuthorization: BuyerSigningAuthorization | null | undefined;
  readonly now: Date;
  /** Synthetic/injected signer only in this readiness phase. */
  readonly signer: BuyerAuthorizationSigner;
  readonly expectedUnsignedHash?: string | null;
  readonly ledger?: BuyerSignatureAttemptLedger;
  readonly policyPath?: string;
  readonly cwd?: string;
  readonly commitSha?: string | null;
  /**
   * When true, skip the terminal send throw after persistence so callers can
   * inspect the signed result. Productive defaults throw.
   */
  readonly returnBeforeSendGateThrow?: boolean;
}

export interface AuthorizedBuyerSigningResult {
  readonly ok: false;
  readonly blocker: typeof BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED;
  readonly signed_artifact: SignedArtifact;
  readonly signed_artifact_sha256: string;
  readonly signature_attempt_id: string;
  readonly ledger_status: "SIGNED_PERSISTED";
  readonly signer_invoked: true;
  readonly payment_header_created: false;
  readonly payment_bearing_request_count: 0;
  readonly sent: false;
  readonly retry_allowed: false;
  readonly policy: B3SignerActivationPolicy;
  readonly validated: ValidatedBuyerAuthorizationForSigning;
}

/**
 * Validated signing → one-shot ledger consume → signer → write-once signed
 * artifact → hard stop before send. Never loads wallet credentials.
 */
export async function runAuthorizedBuyerSigning(
  input: AuthorizedBuyerSigningInput,
): Promise<AuthorizedBuyerSigningResult> {
  const policy = loadB3SignerActivationPolicy(input.policyPath, input.cwd);
  if (policy.real_signing_enabled !== false || policy.credential_provider_enabled !== false) {
    throw new Error(
      `${BLOCKED_B3_REAL_SIGNING_NOT_ENABLED}: signer activation policy must keep real signing and credential providers disabled in this phase`,
    );
  }
  if (policy.wallet_env_loading_enabled !== false || policy.automatic_wallet_discovery !== false) {
    throw new Error(
      `${BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED}: wallet discovery/env loading remain disabled`,
    );
  }

  const validated = prepareValidatedBuyerAuthorizationForSigning({
    unsignedArtifact: input.unsignedArtifact,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
    signingAuthorization: input.signingAuthorization,
    now: input.now,
    expectedUnsignedHash: input.expectedUnsignedHash,
  });

  return signValidatedBuyerAuthorization({
    directory: input.directory,
    validated,
    signer: input.signer,
    now: input.now,
    ledger: input.ledger,
    commitSha: input.commitSha ?? input.unsignedArtifact.commit_sha,
    policy,
    returnBeforeSendGateThrow: input.returnBeforeSendGateThrow,
  });
}

export async function signValidatedBuyerAuthorization(input: {
  readonly directory: string;
  readonly validated: ValidatedBuyerAuthorizationForSigning;
  readonly signer: BuyerAuthorizationSigner;
  readonly now: Date;
  readonly ledger?: BuyerSignatureAttemptLedger;
  readonly commitSha?: string | null;
  readonly policy: B3SignerActivationPolicy;
  readonly returnBeforeSendGateThrow?: boolean;
}): Promise<AuthorizedBuyerSigningResult> {
  const { validated, signer, now } = input;
  const ledger = input.ledger ?? new BuyerSignatureAttemptLedger();
  const decisionId = validated.signingAuthorization.decision_id;
  const unsignedHash = validated.unsignedArtifactSha256;

  ledger.assertNotConsumed(decisionId, unsignedHash);

  const signatureAttemptId = `sig_${validated.unsignedArtifact.attempt_id}_${now.getTime()}`;
  // Consume and durable-mark before invoking the signer so crashes cannot resign.
  ledger.markSignerInvoked({
    signingAuthorizationDecisionId: decisionId,
    signingAuthorizationSha256: validated.signingAuthorizationSha256,
    unsignedArtifactSha256: unsignedHash,
    attemptId: validated.unsignedArtifact.attempt_id,
    runId: validated.unsignedArtifact.run_id,
    now,
    signatureAttemptId,
  });
  ledger.persist(input.directory, decisionId, unsignedHash);

  const expectedBuyer = requireHexAddress(
    validated.unsignedArtifact.buyer_wallet,
    "buyer wallet",
  );
  if (!sameAddress(signer.address, expectedBuyer)) {
    ledger.markAmbiguous(decisionId, unsignedHash);
    throw new Error(
      `${BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH}: signer is not the authorized buyer wallet`,
    );
  }

  let signature: HexSignature;
  try {
    signature = requireHexSignature(await signer.signTypedData(validated.typedData));
  } catch (error) {
    ledger.markAmbiguous(decisionId, unsignedHash);
    throw error;
  }

  const signedCore = {
    unsigned_payload_sha256: validated.unsignedArtifact.canonical_unsigned_payload_sha256,
    signer_address: signer.address,
    signature,
  };
  const signedArtifact: SignedArtifact = {
    schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
    run_id: validated.unsignedArtifact.run_id,
    attempt_id: validated.unsignedArtifact.attempt_id,
    commit_sha: input.commitSha ?? null,
    created_at: now.toISOString(),
    state: "SIGNED_PERSISTED",
    unsigned_artifact_path: UNSIGNED_ARTIFACT,
    unsigned_artifact_sha256: unsignedHash,
    unsigned_payload_sha256: validated.unsignedArtifact.canonical_unsigned_payload_sha256,
    signer_address: signer.address,
    signature,
    signature_encoding: "eip712-65-byte-hex",
    canonical_signed_payload_sha256: canonicalJsonSha256(signedCore),
    signed_at: now.toISOString(),
    payment_header_created: false,
    payment_bearing_request_count: 0,
    sent: false,
    retry_allowed: false,
  };

  const provenanceCompanion = {
    schema_version: "trustforge_buyer_signed_provenance.v1",
    signing_authorization_sha256: validated.signingAuthorizationSha256,
    signature_attempt_id: signatureAttemptId,
    request_binding_sha256: validated.unsignedArtifact.request_binding_sha256,
    canonical_requirements_sha256: validated.unsignedArtifact.canonical_requirements_sha256,
    amount_atomic: validated.unsignedArtifact.seller_amount_atomic,
    asset: validated.unsignedArtifact.asset,
    pay_to: validated.unsignedArtifact.pay_to,
    canonical_network_caip2: validated.unsignedArtifact.canonical_network_caip2,
    payment_header_created: false,
    payment_bearing_request_count: 0,
    sent: false,
    retry_allowed: false,
  };

  let signedWrite: { sha256: string };
  try {
    signedWrite = persistSignedArtifact(input.directory, signedArtifact);
    writeArtifactOnce(
      join(input.directory, "buyer_authorization_signed_provenance.json"),
      provenanceCompanion,
    );
    ledger.markSignedPersisted(decisionId, unsignedHash);
  } catch (error) {
    ledger.markAmbiguous(decisionId, unsignedHash);
    throw error;
  }

  const result: AuthorizedBuyerSigningResult = {
    ok: false,
    blocker: BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED,
    signed_artifact: signedArtifact,
    signed_artifact_sha256: signedWrite.sha256,
    signature_attempt_id: signatureAttemptId,
    ledger_status: "SIGNED_PERSISTED",
    signer_invoked: true,
    payment_header_created: false,
    payment_bearing_request_count: 0,
    sent: false,
    retry_allowed: false,
    policy: input.policy,
    validated,
  };

  if (input.returnBeforeSendGateThrow) {
    return result;
  }
  assertB3PaymentBearingSendNotAuthorized();
}
