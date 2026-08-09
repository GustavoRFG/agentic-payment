/**
 * b3-execution-gates — granular B.3 signer / send gates.
 *
 * Signing authorization is independent of prepare and of payment-bearing send.
 * No environment-variable escape hatch.
 */

export const BLOCKED_B3_SIGNER_ACTIVATION_POLICY_MISSING =
  "BLOCKED_B3_SIGNER_ACTIVATION_POLICY_MISSING" as const;
export const BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID =
  "BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID" as const;
export const BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_MISSING =
  "BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_MISSING" as const;
export const BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID =
  "BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_INVALID" as const;
export const BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_EXPIRED =
  "BLOCKED_B3_REAL_SIGNING_AUTHORIZATION_EXPIRED" as const;
export const BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED =
  "BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED" as const;
export const BLOCKED_B3_REAL_SIGNING_NOT_ENABLED =
  "BLOCKED_B3_REAL_SIGNING_NOT_ENABLED" as const;
export const BLOCKED_B3_SIGNATURE_ATTEMPT_CONSUMED =
  "BLOCKED_B3_SIGNATURE_ATTEMPT_CONSUMED" as const;
export const BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS =
  "BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS" as const;
export const BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED =
  "BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED" as const;

export function assertB3PaymentBearingSendNotAuthorized(): never {
  throw new Error(
    `${BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED}: signing authorization does not authorize payment headers, paid fetch, or settlement send`,
  );
}

export function assertB3RealSignerCredentialProviderNotAuthorized(): never {
  throw new Error(
    `${BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED}: no productive credential provider is authorized; wallet env, filesystem keys, browser, RPC, and hardware wallets remain disabled`,
  );
}
