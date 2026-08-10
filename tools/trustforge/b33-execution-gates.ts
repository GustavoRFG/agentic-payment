/**
 * b33-execution-gates — explicit-runtime-key adapter failures.
 *
 * Never include credential material in error messages.
 */

export const BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING =
  "BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING" as const;
export const BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID =
  "BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID" as const;
export const BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS =
  "BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS" as const;
export const BLOCKED_B33_RUNTIME_KEY_ADAPTER_MISUSE =
  "BLOCKED_B33_RUNTIME_KEY_ADAPTER_MISUSE" as const;

export function assertB33RuntimeKeyCredentialMissing(): never {
  throw new Error(
    `${BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING}: explicit runtime key credential was not supplied after authorization`,
  );
}

export function assertB33RuntimeKeyCredentialInvalid(detail: string): never {
  throw new Error(`${BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_INVALID}: ${detail}`);
}
