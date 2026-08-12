/**
 * windows-dpapi-local-signer — B.4 protected local signer provider.
 *
 * Decrypts vault transiently, derives identity, signs once, zeros plaintext.
 * Never falls back to env/file plaintext. Never prompts for private key.
 */

import { privateKeyToAccount } from "viem/accounts";

import {
  B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
  GUARD_NO_NORMAL_PAYMENT_PRIVATE_KEY_PROMPT,
  GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV,
  GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_FILE_PLAINTEXT,
} from "./b4-execution-gates";
import { BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH } from "./b32-execution-gates";
import type {
  AuthorizedCredentialAccessRequest,
  BuyerCredentialProvider,
  BuyerSignerIdentity,
  CredentialProviderContext,
} from "./buyer-credential-provider";
import type {
  BuyerAuthorizationSigner,
  HexAddress,
  HexSignature,
} from "./buyer-authorization-signer";
import type { ValidatedBuyerTypedData } from "./buyer-validated-signing";
import type { CredentialBackendInput } from "./buyer-credential-backend-types";
import {
  decryptProtectedSignerVault,
  loadProtectedSignerVault,
  vaultPathForBuyer,
} from "./buyer-protected-signer-vault";
import {
  createWindowsDpapiCurrentUserBackend,
  type ProtectedSecretBackend,
} from "./windows-dpapi-protect";
import { zeroCredentialBytes } from "./buyer-credential-transport-frame";

export {
  B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
  B4_PROTECTED_SIGNER_PROVIDER_ID,
};

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}

/** Authorized key→address derivation for this provider and one-time setup. */
export function deriveAddressFromPrivateKeyBytes(plaintext: Uint8Array): HexAddress {
  if (plaintext.length !== 32) {
    fail(BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE, "private key must be 32 bytes");
  }
  return privateKeyToAccount(bytesToHex(plaintext)).address as HexAddress;
}

function assertNoEnvFallback(): void {
  void GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV;
  void GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_FILE_PLAINTEXT;
  void GUARD_NO_NORMAL_PAYMENT_PRIVATE_KEY_PROMPT;
  if (process.env.BUYER_PRIVATE_KEY || process.env.SEPOLIA_BUYER_PRIVATE_KEY) {
    fail(
      GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV,
      "env key present; protected signer refuses fallback",
    );
  }
}

export function createWindowsDpapiLocalSignerProvider(options?: {
  readonly vaultBaseDir?: string;
  readonly backend?: ProtectedSecretBackend;
  readonly vaultPathOverride?: string;
}): BuyerCredentialProvider {
  const backend = options?.backend ?? createWindowsDpapiCurrentUserBackend();

  return {
    providerId: B4_PROTECTED_SIGNER_PROVIDER_ID,
    credentialKind: B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
    async resolveSignerIdentity(
      context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      return {
        address: context.expectedSignerAddress,
        providerId: B4_PROTECTED_SIGNER_PROVIDER_ID,
        credentialKind: B4_PROTECTED_SIGNER_CREDENTIAL_KIND,
        identityResolvedWithoutSecret: true,
      };
    },
    async acquireSigner(
      request: AuthorizedCredentialAccessRequest,
      credentialInput?: CredentialBackendInput,
    ): Promise<BuyerAuthorizationSigner> {
      assertNoEnvFallback();
      if (credentialInput) {
        fail(
          BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
          "windows-dpapi-local-signer does not accept external credentialInput (no key prompt path)",
        );
      }
      if (request.accessAuthorization.provider_id !== B4_PROTECTED_SIGNER_PROVIDER_ID) {
        fail(
          BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
          "credential auth provider_id mismatch",
        );
      }
      const expected = request.context.expectedSignerAddress.toLowerCase();
      const vaultPath =
        options?.vaultPathOverride ??
        vaultPathForBuyer(expected, options?.vaultBaseDir);
      let plaintext: Uint8Array | null = null;
      try {
        const record = loadProtectedSignerVault(vaultPath);
        if (record.expected_public_address.toLowerCase() !== expected) {
          fail(
            BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH,
            "vault expected address != authorization expected signer",
          );
        }
        plaintext = decryptProtectedSignerVault({ record, backend });
        if (plaintext.length !== 32) {
          fail(BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE, "decrypted key length invalid");
        }
        const account = privateKeyToAccount(bytesToHex(plaintext));
        const derived = deriveAddressFromPrivateKeyBytes(plaintext);
        if (derived.toLowerCase() !== expected) {
          fail(
            BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH,
            "derived vault signer != expected buyer",
          );
        }
        const address = derived;
        const signer: BuyerAuthorizationSigner = {
          address,
          async signTypedData(typed: ValidatedBuyerTypedData): Promise<HexSignature> {
            const sig = await account.signTypedData({
              domain: typed.domain as never,
              types: typed.types as never,
              primaryType: typed.primaryType as never,
              message: typed.message as never,
            });
            return sig as HexSignature;
          },
        };
        return signer;
      } finally {
        if (plaintext) {
          zeroCredentialBytes(plaintext);
          plaintext = null;
        }
      }
    },
  };
}
