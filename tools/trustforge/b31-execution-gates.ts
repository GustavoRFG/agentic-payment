/**
 * b31-execution-gates — credential-provider selection vs credential access.
 *
 * Provider configuration/selection is independent of privileged credential access.
 * No environment-variable escape hatch.
 */

export const BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_MISSING =
  "BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_MISSING" as const;
export const BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID =
  "BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID" as const;
export const BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED =
  "BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED" as const;
export const BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING =
  "BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_MISSING" as const;
export const BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID =
  "BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_INVALID" as const;
export const BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_EXPIRED =
  "BLOCKED_B31_CREDENTIAL_ACCESS_AUTHORIZATION_EXPIRED" as const;
export const BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH =
  "BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH" as const;
export const BLOCKED_B31_CREDENTIAL_ACCESS_CONSUMED =
  "BLOCKED_B31_CREDENTIAL_ACCESS_CONSUMED" as const;
export const BLOCKED_B31_CREDENTIAL_ACCESS_AMBIGUOUS =
  "BLOCKED_B31_CREDENTIAL_ACCESS_AMBIGUOUS" as const;
export const BLOCKED_B31_PROVIDER_MISMATCH =
  "BLOCKED_B31_PROVIDER_MISMATCH" as const;

export function assertB31CredentialAccessNotAuthorized(): never {
  throw new Error(
    `${BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED}: credential provider may be configured/selected but credential access remains unauthorized; no private key, wallet env, browser, or hardware wallet may be opened`,
  );
}
