/**
 * buyer-credential-backend-types — credential input shapes for backends.
 * No secrets are loaded by this module.
 */

/**
 * Explicit runtime key — supplied only after authorization; never from process.env.
 * Prefer mutable Uint8Array so callers can zero buffers after use.
 * Immutable hex strings cannot be securely erased by the JS runtime.
 */
export interface ExplicitRuntimeKeyCredentialInput {
  readonly kind: "explicit-runtime-key";
  readonly privateKey: Uint8Array | `0x${string}`;
}

/** Encrypted local keystore — exact path + password only after authorization. */
export interface EncryptedLocalKeystoreCredentialInput {
  readonly kind: "encrypted-local-keystore";
  /** Exact absolute or policy-bound path; never a directory search pattern. */
  readonly keystorePath: string;
  readonly password: string;
}

/** External signer — non-secret identifier + validated EIP-712 only. */
export interface ExternalSignerCredentialInput {
  readonly kind: "external-signer";
  readonly signerIdentifier: string;
  readonly chainId: number;
}

/** OS/HSM/KMS-like secure signing provider — non-secret handle only. */
export interface SecureSigningProviderCredentialInput {
  readonly kind: "secure-signing-provider";
  readonly providerHandle: string;
  readonly chainId: number;
}

export type CredentialBackendInput =
  | ExplicitRuntimeKeyCredentialInput
  | EncryptedLocalKeystoreCredentialInput
  | ExternalSignerCredentialInput
  | SecureSigningProviderCredentialInput;
