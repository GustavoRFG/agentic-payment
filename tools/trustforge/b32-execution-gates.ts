/**
 * b32-execution-gates — signer mechanism / provider registry readiness.
 *
 * Real backends remain inactive. Selection is explicit; no implicit fallback.
 */

export const BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN =
  "BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN" as const;
export const BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS =
  "BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS" as const;
export const BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE =
  "BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE" as const;
export const BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH =
  "BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH" as const;
export const BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID =
  "BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID" as const;

export function assertB32RealCredentialBackendInactive(providerId: string): never {
  throw new Error(
    `${BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE}: provider ${providerId} is registered but its real credential backend remains inactive; no secret, keystore, hardware, or remote signer may be opened`,
  );
}
