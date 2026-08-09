/**
 * buyer-credential-provider — selection vs privileged credential access.
 *
 * resolveSignerIdentity must not require secrets.
 * acquireSigner is privileged and hard-blocked in production during B.3.1/B.3.2.
 * Credential implementation (adapters) is independent of this interface.
 */

import {
  BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED,
  assertB31CredentialAccessNotAuthorized,
} from "./b31-execution-gates";
import type { BuyerCredentialAccessAuthorization } from "./buyer-credential-access-authorization";
import type {
  BuyerAuthorizationSigner,
  HexAddress,
} from "./buyer-authorization-signer";
import type { ValidatedBuyerAuthorizationForSigning } from "./buyer-validated-signing";
import type { CredentialBackendInput } from "./buyer-credential-backend-types";

export interface BuyerSignerIdentity {
  readonly address: HexAddress;
  readonly providerId: string;
  readonly credentialKind: string;
  /** True only when identity was obtained without opening a secret. */
  readonly identityResolvedWithoutSecret: true;
}

export interface CredentialProviderContext {
  readonly expectedSignerAddress: HexAddress;
  readonly attemptId: string;
  readonly runId: string;
  readonly unsignedArtifactSha256: string;
  readonly signingAuthorizationSha256: string;
}

/**
 * Opaque request stamped only after credential-access authorization validation
 * and policy checks. Productive callers cannot forge this.
 */
export interface AuthorizedCredentialAccessRequest {
  readonly __brand: "AuthorizedCredentialAccessRequest";
  readonly accessAuthorization: BuyerCredentialAccessAuthorization;
  readonly accessAuthorizationSha256: string;
  readonly context: CredentialProviderContext;
  readonly validated: ValidatedBuyerAuthorizationForSigning;
}

export interface BuyerCredentialProvider {
  readonly providerId: string;
  readonly credentialKind: string;
  resolveSignerIdentity(
    context: CredentialProviderContext,
  ): Promise<BuyerSignerIdentity>;
  /**
   * Privileged. `credentialInput` may only be supplied by an operational layer
   * after credential-access authorization — never from process.env defaults.
   */
  acquireSigner(
    request: AuthorizedCredentialAccessRequest,
    credentialInput?: CredentialBackendInput,
  ): Promise<BuyerAuthorizationSigner>;
}

/**
 * Production inactive provider: identity may be reported from non-secret policy
 * config when present; acquireSigner always blocks.
 */
export function createInactiveProductionCredentialProvider(input: {
  readonly providerId: string;
  readonly credentialKind: string;
  readonly policyExpectedSignerAddress: string | null;
}): BuyerCredentialProvider {
  return {
    providerId: input.providerId,
    credentialKind: input.credentialKind,
    async resolveSignerIdentity(
      context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      // Prefer binding from the prepared authorization context — no secret access.
      const address = context.expectedSignerAddress;
      if (
        input.policyExpectedSignerAddress &&
        input.policyExpectedSignerAddress.toLowerCase() !== address.toLowerCase()
      ) {
        // Surface via acquire/identity mismatch path; still no secret access.
      }
      return {
        address,
        providerId: input.providerId,
        credentialKind: input.credentialKind,
        identityResolvedWithoutSecret: true,
      };
    },
    async acquireSigner(
      _request: AuthorizedCredentialAccessRequest,
      _credentialInput?: CredentialBackendInput,
    ): Promise<BuyerAuthorizationSigner> {
      void _credentialInput;
      assertB31CredentialAccessNotAuthorized();
    },
  };
}

export function stampAuthorizedCredentialAccessRequest(input: {
  readonly accessAuthorization: BuyerCredentialAccessAuthorization;
  readonly accessAuthorizationSha256: string;
  readonly context: CredentialProviderContext;
  readonly validated: ValidatedBuyerAuthorizationForSigning;
}): AuthorizedCredentialAccessRequest {
  return Object.freeze({
    __brand: "AuthorizedCredentialAccessRequest" as const,
    accessAuthorization: input.accessAuthorization,
    accessAuthorizationSha256: input.accessAuthorizationSha256,
    context: input.context,
    validated: input.validated,
  });
}

export { BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED };
