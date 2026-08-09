/**
 * Test-only synthetic credential provider.
 *
 * Productive code must never import this module. No real key material.
 */

import type {
  AuthorizedCredentialAccessRequest,
  BuyerCredentialProvider,
  BuyerSignerIdentity,
  CredentialProviderContext,
} from "../../tools/trustforge/buyer-credential-provider";
import type {
  BuyerAuthorizationSigner,
  HexAddress,
  HexSignature,
} from "../../tools/trustforge/buyer-authorization-signer";
import type { ValidatedBuyerTypedData } from "../../tools/trustforge/buyer-validated-signing";

export const SYNTHETIC_CREDENTIAL_PROVIDER_ID = "synthetic" as const;
export const SYNTHETIC_CREDENTIAL_KIND = "synthetic_fixture" as const;

export function createSyntheticBuyerCredentialProvider(input: {
  readonly address: HexAddress;
  readonly signature?: HexSignature;
}): BuyerCredentialProvider & {
  resolveCalls: number;
  acquireCalls: number;
  signerCalls: number;
} {
  const signature = (input.signature ?? (`0x${"ab".repeat(65)}` as HexSignature));
  const provider = {
    providerId: SYNTHETIC_CREDENTIAL_PROVIDER_ID,
    credentialKind: SYNTHETIC_CREDENTIAL_KIND,
    resolveCalls: 0,
    acquireCalls: 0,
    signerCalls: 0,
    async resolveSignerIdentity(
      _context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      provider.resolveCalls += 1;
      return {
        address: input.address,
        providerId: SYNTHETIC_CREDENTIAL_PROVIDER_ID,
        credentialKind: SYNTHETIC_CREDENTIAL_KIND,
        identityResolvedWithoutSecret: true,
      };
    },
    async acquireSigner(
      request: AuthorizedCredentialAccessRequest,
    ): Promise<BuyerAuthorizationSigner> {
      provider.acquireCalls += 1;
      void request;
      return {
        address: input.address,
        async signTypedData(_typed: ValidatedBuyerTypedData): Promise<HexSignature> {
          provider.signerCalls += 1;
          return signature;
        },
      };
    },
  };
  return provider;
}
