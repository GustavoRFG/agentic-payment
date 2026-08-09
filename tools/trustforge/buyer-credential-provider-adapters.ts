/**
 * buyer-credential-provider-adapters — inactive real signer mechanism contracts.
 *
 * Every real adapter terminates with BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE
 * before any secret/backend access. No env reads, file reads, hardware, or remote calls.
 *
 * Productive signers expose only ValidatedBuyerTypedData signing — never general
 * signMessage / arbitrary signTypedData / signTransaction.
 */

import {
  BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH,
  assertB32RealCredentialBackendInactive,
} from "./b32-execution-gates";
import type {
  CredentialBackendInput,
  ExplicitRuntimeKeyCredentialInput,
} from "./buyer-credential-backend-types";
import type {
  AuthorizedCredentialAccessRequest,
  BuyerCredentialProvider,
  BuyerSignerIdentity,
  CredentialProviderContext,
} from "./buyer-credential-provider";
import type { BuyerAuthorizationSigner, HexAddress } from "./buyer-authorization-signer";
import type { ValidatedBuyerTypedData } from "./buyer-validated-signing";

export type {
  CredentialBackendInput,
  EncryptedLocalKeystoreCredentialInput,
  ExplicitRuntimeKeyCredentialInput,
  ExternalSignerCredentialInput,
  SecureSigningProviderCredentialInput,
} from "./buyer-credential-backend-types";

function identityFromContext(
  providerId: string,
  credentialKind: string,
  context: CredentialProviderContext,
): BuyerSignerIdentity {
  return {
    address: context.expectedSignerAddress,
    providerId,
    credentialKind,
    identityResolvedWithoutSecret: true,
  };
}

/**
 * Narrow productive signing surface. Adapters must not expose signMessage /
 * signTransaction / unbranded signTypedData to TrustForge callers.
 */
export type RestrictedBuyerAuthorizationSigner = BuyerAuthorizationSigner & {
  readonly signMessage?: never;
  readonly signTransaction?: never;
};

function assertExpectedAddress(
  actual: string,
  expected: HexAddress,
  label: string,
): void {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(
      `${BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH}: ${label} ${actual} != expected ${expected}`,
    );
  }
}

/**
 * Documented future acquire shape for explicit-runtime-key.
 * Inactive implementation never reads credentialInput.privateKeyHex.
 */
export async function acquireExplicitRuntimeKeySignerInactive(input: {
  readonly authorizedRequest: AuthorizedCredentialAccessRequest;
  readonly credentialInput?: ExplicitRuntimeKeyCredentialInput;
}): Promise<RestrictedBuyerAuthorizationSigner> {
  void input.credentialInput;
  void input.authorizedRequest;
  assertB32RealCredentialBackendInactive("explicit-runtime-key");
}

export function createInactiveExplicitRuntimeKeyProvider(): BuyerCredentialProvider {
  const providerId = "explicit-runtime-key";
  const credentialKind = "explicit_runtime_private_key";
  return {
    providerId,
    credentialKind,
    async resolveSignerIdentity(
      context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      return identityFromContext(providerId, credentialKind, context);
    },
    async acquireSigner(
      request: AuthorizedCredentialAccessRequest,
      credentialInput?: CredentialBackendInput,
    ): Promise<BuyerAuthorizationSigner> {
      if (credentialInput != null && credentialInput.kind !== "explicit-runtime-key") {
        throw new Error(
          `${BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH}: credentialInput.kind must be explicit-runtime-key`,
        );
      }
      return acquireExplicitRuntimeKeySignerInactive({
        authorizedRequest: request,
        credentialInput: credentialInput as ExplicitRuntimeKeyCredentialInput | undefined,
      });
    },
  };
}

export function createInactiveEncryptedLocalKeystoreProvider(): BuyerCredentialProvider {
  const providerId = "encrypted-local-keystore";
  const credentialKind = "encrypted_local_keystore";
  return {
    providerId,
    credentialKind,
    async resolveSignerIdentity(
      context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      return identityFromContext(providerId, credentialKind, context);
    },
    async acquireSigner(
      _request: AuthorizedCredentialAccessRequest,
      credentialInput?: CredentialBackendInput,
    ): Promise<BuyerAuthorizationSigner> {
      void credentialInput;
      assertB32RealCredentialBackendInactive(providerId);
    },
  };
}

export function createInactiveExternalSignerProvider(): BuyerCredentialProvider {
  const providerId = "external-signer";
  const credentialKind = "external_signer";
  return {
    providerId,
    credentialKind,
    async resolveSignerIdentity(
      context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      return identityFromContext(providerId, credentialKind, context);
    },
    async acquireSigner(
      _request: AuthorizedCredentialAccessRequest,
      credentialInput?: CredentialBackendInput,
    ): Promise<BuyerAuthorizationSigner> {
      void credentialInput;
      assertB32RealCredentialBackendInactive(providerId);
    },
  };
}

export function createInactiveSecureSigningProvider(): BuyerCredentialProvider {
  const providerId = "secure-signing-provider";
  const credentialKind = "secure_signing_provider";
  return {
    providerId,
    credentialKind,
    async resolveSignerIdentity(
      context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      return identityFromContext(providerId, credentialKind, context);
    },
    async acquireSigner(
      _request: AuthorizedCredentialAccessRequest,
      credentialInput?: CredentialBackendInput,
    ): Promise<BuyerAuthorizationSigner> {
      void credentialInput;
      assertB32RealCredentialBackendInactive(providerId);
    },
  };
}

/**
 * Memory / lifetime policy documentation constants (no secrets held).
 * JavaScript cannot guarantee deterministic secure erasure of secret bytes.
 */
export const B32_CREDENTIAL_MEMORY_LIFECYCLE_POLICY = Object.freeze({
  credential_acquisition: "one-shot",
  credential_cache: "disabled",
  cross_attempt_reuse: "disabled",
  cross_run_reuse: "disabled",
  automatic_reacquisition: "disabled",
  no_logging: true,
  no_exception_serialization_of_secret: true,
  no_json_persistence: true,
  no_evidence_artifact_inclusion: true,
  no_global_singleton: true,
  no_process_level_cache: true,
  javascript_secure_erasure_guaranteed: false,
  javascript_secure_erasure_limitation:
    "V8/JS does not provide deterministic secure memory erasure; minimize lifetime and drop references only.",
});

/** Structural check helper for tests: productive signer type accepts only validated typed data. */
export function assertRestrictedSignerSurface(signer: RestrictedBuyerAuthorizationSigner): void {
  const anySigner = signer as RestrictedBuyerAuthorizationSigner & {
    signMessage?: unknown;
    signTransaction?: unknown;
  };
  if (typeof anySigner.signMessage === "function") {
    throw new Error("general-purpose signMessage must not be exposed");
  }
  if (typeof anySigner.signTransaction === "function") {
    throw new Error("general-purpose signTransaction must not be exposed");
  }
  void (null as unknown as ValidatedBuyerTypedData);
  void assertExpectedAddress;
}
