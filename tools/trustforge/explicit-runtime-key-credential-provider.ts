/**
 * explicit-runtime-key-credential-provider — B.3.3 production adapter.
 *
 * Receives credentials only through an authorized acquire call.
 * Never reads environment variables, disk secrets, files, registries, or caches.
 *
 * privateKeyToAccount is confined to this module for buyer runtime-key use.
 * Deterministic secure erasure of JS string secrets is NOT guaranteed.
 */

import { privateKeyToAccount } from "viem/accounts";

import {
  BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH,
} from "./b32-execution-gates";
import {
  BLOCKED_B33_RUNTIME_KEY_ADAPTER_MISUSE,
  BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS,
  assertB33RuntimeKeyCredentialInvalid,
  assertB33RuntimeKeyCredentialMissing,
} from "./b33-execution-gates";
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
import type {
  BuyerAuthorizationSigner,
  HexAddress,
  HexSignature,
} from "./buyer-authorization-signer";
import type { ValidatedBuyerTypedData } from "./buyer-validated-signing";

/** Narrow surface — no general-purpose wallet APIs. */
type RestrictedBuyerAuthorizationSigner = BuyerAuthorizationSigner & {
  readonly signMessage?: never;
  readonly signTransaction?: never;
};

export const EXPLICIT_RUNTIME_KEY_PROVIDER_ID = "explicit-runtime-key" as const;
export const EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND =
  "explicit_runtime_private_key" as const;

/** secp256k1 curve order n (exclusive upper bound for private keys). */
const SECP256K1_N = BigInt(
  "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
);

/**
 * Opaque capability: only stampable from a validated AuthorizedCredentialAccessRequest
 * for the explicit-runtime-key provider.
 */
export interface AuthorizedExplicitRuntimeCredentialAccess {
  readonly __brand: "AuthorizedExplicitRuntimeCredentialAccess";
  readonly authorizedRequest: AuthorizedCredentialAccessRequest;
}

export function stampAuthorizedExplicitRuntimeCredentialAccess(
  request: AuthorizedCredentialAccessRequest,
): AuthorizedExplicitRuntimeCredentialAccess {
  if (request.__brand !== "AuthorizedCredentialAccessRequest") {
    throw new Error(
      `${BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS}: AuthorizedCredentialAccessRequest brand required`,
    );
  }
  if (request.accessAuthorization.provider_id !== EXPLICIT_RUNTIME_KEY_PROVIDER_ID) {
    throw new Error(
      `${BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS}: provider_id must be ${EXPLICIT_RUNTIME_KEY_PROVIDER_ID}`,
    );
  }
  if (
    request.accessAuthorization.credential_kind !== EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND
  ) {
    throw new Error(
      `${BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS}: credential_kind must be ${EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND}`,
    );
  }
  return Object.freeze({
    __brand: "AuthorizedExplicitRuntimeCredentialAccess" as const,
    authorizedRequest: request,
  });
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  let hex = "0x";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex as `0x${string}`;
}

/**
 * Validate private-key representation without echoing material.
 * Accepts only exact 32-byte secp256k1 scalars in (0, n).
 */
export function validateExplicitRuntimePrivateKey(
  privateKey: Uint8Array | `0x${string}` | null | undefined,
): {
  readonly hex: `0x${string}`;
  readonly ownedBytes: Uint8Array | null;
} {
  if (privateKey == null) {
    assertB33RuntimeKeyCredentialMissing();
  }

  let ownedBytes: Uint8Array | null = null;
  let hex: `0x${string}`;

  if (typeof privateKey === "string") {
    // No silent trim / case-folding of surrounding text — exact 0x + 64 hex.
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      assertB33RuntimeKeyCredentialInvalid(
        "private key must be exactly 0x-prefixed 32-byte hex (no mnemonic/password)",
      );
    }
    hex = privateKey.toLowerCase() as `0x${string}`;
    // Lowercasing hex digits does not change key material bits.
  } else if (privateKey instanceof Uint8Array) {
    if (privateKey.byteLength !== 32) {
      assertB33RuntimeKeyCredentialInvalid("private key byte length must be exactly 32");
    }
    ownedBytes = new Uint8Array(privateKey);
    hex = bytesToHex(ownedBytes);
  } else {
    assertB33RuntimeKeyCredentialInvalid("unsupported private key representation");
  }

  const asInt = BigInt(hex);
  if (asInt === 0n) {
    assertB33RuntimeKeyCredentialInvalid("private key must be non-zero");
  }
  if (asInt >= SECP256K1_N) {
    assertB33RuntimeKeyCredentialInvalid("private key outside secp256k1 scalar range");
  }

  return { hex, ownedBytes };
}

function clearBytes(bytes: Uint8Array | null): void {
  if (bytes) {
    bytes.fill(0);
  }
}

export interface ExplicitRuntimeKeyAcquireEvidence {
  readonly credential_supplied: boolean;
  readonly credential_format_valid: boolean;
  readonly derived_signer_address: HexAddress | null;
  readonly credential_persisted: false;
  readonly account_derivations: number;
}

/**
 * Privileged acquire — requires branded access + explicit credential.
 * No discovery. No cache. No logging of secret material.
 */
export async function acquireExplicitRuntimeKeySigner(input: {
  readonly authorizedCredentialAccess: AuthorizedExplicitRuntimeCredentialAccess;
  readonly credential: ExplicitRuntimeKeyCredentialInput | null | undefined;
}): Promise<{
  readonly signer: RestrictedBuyerAuthorizationSigner;
  readonly evidence: ExplicitRuntimeKeyAcquireEvidence;
}> {
  if (input.authorizedCredentialAccess.__brand !== "AuthorizedExplicitRuntimeCredentialAccess") {
    throw new Error(
      `${BLOCKED_B33_RUNTIME_KEY_UNAUTHORIZED_ACCESS}: AuthorizedExplicitRuntimeCredentialAccess brand required`,
    );
  }

  const expected =
    input.authorizedCredentialAccess.authorizedRequest.context.expectedSignerAddress;
  const signingBuyer =
    input.authorizedCredentialAccess.authorizedRequest.validated.signingAuthorization
      .buyer_wallet;
  const typedFrom =
    input.authorizedCredentialAccess.authorizedRequest.validated.typedData.message.from;

  if (
    expected.toLowerCase() !== signingBuyer.toLowerCase() ||
    expected.toLowerCase() !== typedFrom.toLowerCase()
  ) {
    throw new Error(
      `${BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH}: authorized expected signer disagrees with signing authorization / typed-data from`,
    );
  }

  if (!input.credential || input.credential.kind !== "explicit-runtime-key") {
    assertB33RuntimeKeyCredentialMissing();
  }

  let ownedBytes: Uint8Array | null = null;
  let accountDerivations = 0;
  try {
    const validatedKey = validateExplicitRuntimePrivateKey(input.credential.privateKey);
    ownedBytes = validatedKey.ownedBytes;

    let account: ReturnType<typeof privateKeyToAccount>;
    try {
      account = privateKeyToAccount(validatedKey.hex);
      accountDerivations = 1;
    } catch {
      assertB33RuntimeKeyCredentialInvalid("account derivation rejected the private key");
    }

    const derived = account.address as HexAddress;
    if (derived.toLowerCase() !== expected.toLowerCase()) {
      throw new Error(
        `${BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH}: derived signer ${derived} != expected ${expected}`,
      );
    }

    const signer: RestrictedBuyerAuthorizationSigner = {
      address: derived,
      async signTypedData(request: ValidatedBuyerTypedData): Promise<HexSignature> {
        // Narrow capability: only the B.3 validated EIP-3009 typed-data shape.
        if (
          !request ||
          request.primaryType !== "TransferWithAuthorization" ||
          !request.domain ||
          !request.types ||
          !request.message ||
          typeof request.message.from !== "string"
        ) {
          throw new Error(
            `${BLOCKED_B33_RUNTIME_KEY_ADAPTER_MISUSE}: only validated buyer EIP-3009 typed data may be signed`,
          );
        }
        const signature = await account.signTypedData({
          domain: request.domain as Parameters<typeof account.signTypedData>[0]["domain"],
          types: request.types as Parameters<typeof account.signTypedData>[0]["types"],
          primaryType: request.primaryType,
          message: request.message as Parameters<typeof account.signTypedData>[0]["message"],
        });
        return signature as HexSignature;
      },
    };

    return {
      signer,
      evidence: {
        credential_supplied: true,
        credential_format_valid: true,
        derived_signer_address: derived,
        credential_persisted: false,
        account_derivations: accountDerivations,
      },
    };
  } finally {
    clearBytes(ownedBytes);
  }
}

export function createExplicitRuntimeKeyCredentialProvider(): BuyerCredentialProvider & {
  acquireCalls: number;
  accountDerivations: number;
  signerCalls: number;
} {
  const provider = {
    providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
    acquireCalls: 0,
    accountDerivations: 0,
    signerCalls: 0,
    async resolveSignerIdentity(
      context: CredentialProviderContext,
    ): Promise<BuyerSignerIdentity> {
      // Non-secret: expected address from authorization context only.
      return {
        address: context.expectedSignerAddress,
        providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
        credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
        identityResolvedWithoutSecret: true,
      };
    },
    async acquireSigner(
      request: AuthorizedCredentialAccessRequest,
      credentialInput?: CredentialBackendInput,
    ): Promise<BuyerAuthorizationSigner> {
      provider.acquireCalls += 1;
      const access = stampAuthorizedExplicitRuntimeCredentialAccess(request);
      const credential =
        credentialInput && credentialInput.kind === "explicit-runtime-key"
          ? credentialInput
          : null;
      try {
        const { signer, evidence } = await acquireExplicitRuntimeKeySigner({
          authorizedCredentialAccess: access,
          credential,
        });
        provider.accountDerivations += evidence.account_derivations;
        return {
          address: signer.address,
          async signTypedData(typed: ValidatedBuyerTypedData): Promise<HexSignature> {
            provider.signerCalls += 1;
            return signer.signTypedData(typed);
          },
        };
      } catch (error) {
        // Count derivation when identity mismatch occurs after privateKeyToAccount.
        if (
          error instanceof Error &&
          error.message.includes(BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH) &&
          /derived signer/.test(error.message)
        ) {
          provider.accountDerivations += 1;
        }
        throw error;
      }
    },
  };
  return provider;
}

/** Documented JS memory limitation — do not claim secure erasure for string keys. */
export const B33_RUNTIME_KEY_MEMORY_POLICY = Object.freeze({
  credential_cache: "none",
  signer_cache: "none",
  cross_attempt_reuse: "forbidden",
  cross_run_reuse: "forbidden",
  mutable_buffer_best_effort_clear: true,
  javascript_string_secure_erasure_guaranteed: false,
  javascript_secure_erasure_limitation:
    "deterministic secure erasure cannot be guaranteed by JavaScript runtime",
});
