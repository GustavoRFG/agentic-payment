/**
 * buyer-credential-gated-signing — B.3.1/B.3.2 path through credential provider.
 *
 * Sequence:
 *   validate unsigned + signing auth
 *   → credential policy + explicit provider registry
 *   → expected signer binding
 *   → credential-access authorization (when access enabled)
 *   → CREDENTIAL ACCESS GATE
 *   → signer-provider adapter (inactive real backends)
 *   → fresh pre-sign revalidation
 *   → signer
 *   → signed persistence
 *   → SEND GATE
 *
 * Production policy keeps credential_access_enabled=false and
 * real_backend_activation=false; stops at
 * BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED with zero provider acquire calls.
 */

import {
  BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED,
  BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH,
  BLOCKED_B31_PROVIDER_MISMATCH,
  assertB31CredentialAccessNotAuthorized,
} from "./b31-execution-gates";
import { BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH } from "./b32-execution-gates";
import { loadB31CredentialProviderPolicy } from "./b31-credential-provider-policy";
import { loadB3SignerActivationPolicy } from "./b3-signer-activation-policy";
import type { UnsignedArtifact } from "./buyer-authorization-artifacts";
import type { BuyerAuthorizationSigner, HexAddress } from "./buyer-authorization-signer";
import {
  runAuthorizedBuyerSigning,
  type AuthorizedBuyerSigningResult,
} from "./buyer-authorization-signer";
import {
  buyerCredentialAccessAuthorizationSha256,
  validateBuyerCredentialAccessAuthorization,
  type BuyerCredentialAccessAuthorization,
} from "./buyer-credential-access-authorization";
import { BuyerCredentialAccessLedger } from "./buyer-credential-access-ledger";
import type { CredentialBackendInput } from "./buyer-credential-backend-types";
import {
  stampAuthorizedCredentialAccessRequest,
  type BuyerCredentialProvider,
  type CredentialProviderContext,
} from "./buyer-credential-provider";
import {
  assertExplicitProviderSelection,
  resolveProductiveCredentialProvider,
} from "./buyer-credential-provider-registry";
import {
  rejectRuntimeKeyTransportFallback,
  stampAuthorizedCredentialTransportRead,
  type OneShotCredentialTransport,
} from "./buyer-credential-transport";
import { zeroCredentialBytes } from "./buyer-credential-transport-frame";
import type { PreSignAttemptArtifact } from "./buyer-pre-sign-validation";
import type { BuyerSigningAuthorization } from "./buyer-signing-authorization";
import { prepareValidatedBuyerAuthorizationForSigning } from "./buyer-validated-signing";
import type { HumanPaymentAuthorization } from "./validate-human-payment-authorization";
import {
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "./explicit-runtime-key-credential-provider";

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function requireHexAddress(value: string, label: string): HexAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH}: ${label} is not a 20-byte address`);
  }
  return value as HexAddress;
}

export interface CredentialGatedSigningInput {
  readonly directory: string;
  readonly unsignedArtifact: UnsignedArtifact;
  readonly attempt: PreSignAttemptArtifact;
  readonly humanAuthorization: HumanPaymentAuthorization;
  readonly signingAuthorization: BuyerSigningAuthorization | null | undefined;
  readonly credentialAccessAuthorization?: BuyerCredentialAccessAuthorization | null;
  readonly now: Date;
  /** Fresh clock for immediate pre-sign revalidation before signTypedData. */
  readonly nowAtSign?: Date;
  readonly expectedUnsignedHash?: string | null;
  readonly provider?: BuyerCredentialProvider;
  /**
   * Explicit credential only — never discovered. Production stops at B.3.1
   * before this is consumed. No interactive prompt in this phase.
   */
  readonly credentialInput?: CredentialBackendInput | null;
  /**
   * Optional one-shot pipe transport. Used only when credentialInput is absent.
   * Never falls back to env/argv/file on failure.
   */
  readonly credentialTransport?: OneShotCredentialTransport | null;
  readonly credentialPolicyPath?: string;
  readonly signerPolicyPath?: string;
  readonly cwd?: string;
  readonly commitSha?: string | null;
  readonly credentialLedger?: BuyerCredentialAccessLedger;
  readonly returnBeforeSendGateThrow?: boolean;
}

/**
 * Production-facing credential-gated entry. With the checked-in policy this
 * always stops before any provider call / acquireSigner.
 */
export async function runCredentialGatedBuyerSigning(
  input: CredentialGatedSigningInput,
): Promise<AuthorizedBuyerSigningResult> {
  loadB3SignerActivationPolicy(input.signerPolicyPath, input.cwd);
  const credentialPolicy = loadB31CredentialProviderPolicy(
    input.credentialPolicyPath,
    input.cwd,
  );

  // B.3.2: explicit registry selection — no implicit fallback / discovery.
  assertExplicitProviderSelection({ policy: credentialPolicy });
  if (credentialPolicy.automatic_discovery_enabled !== false) {
    throw new Error(
      `${BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED}: automatic credential discovery is forbidden`,
    );
  }
  if (credentialPolicy.fallback_provider_enabled !== false) {
    throw new Error(
      `${BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED}: fallback credential providers are forbidden`,
    );
  }
  if (credentialPolicy.real_backend_activation !== false) {
    throw new Error(
      `${BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED}: real credential backend activation is forbidden`,
    );
  }
  if (credentialPolicy.credential_caching_enabled !== false) {
    throw new Error(
      `${BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED}: credential caching is forbidden`,
    );
  }

  // 1) Current validation of unsigned + signing authorization (fresh now).
  const validated = prepareValidatedBuyerAuthorizationForSigning({
    unsignedArtifact: input.unsignedArtifact,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
    signingAuthorization: input.signingAuthorization,
    now: input.now,
    expectedUnsignedHash: input.expectedUnsignedHash,
  });

  // 2) Expected signer identity from authorization + typed-data `from`.
  const expectedFromAuth = requireHexAddress(
    validated.signingAuthorization.buyer_wallet,
    "signing authorization buyer",
  );
  const expectedFromUnsigned = requireHexAddress(
    validated.unsignedArtifact.buyer_wallet,
    "unsigned buyer_wallet",
  );
  const expectedFromMessage = requireHexAddress(
    validated.typedData.message.from,
    "typed-data from",
  );
  if (
    !sameAddress(expectedFromAuth, expectedFromUnsigned) ||
    !sameAddress(expectedFromAuth, expectedFromMessage)
  ) {
    throw new Error(
      `${BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH}: buyer wallet / typed-data from / signing authorization disagree`,
    );
  }
  if (
    credentialPolicy.expected_signer_address &&
    !sameAddress(credentialPolicy.expected_signer_address, expectedFromAuth)
  ) {
    throw new Error(
      `${BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH}: policy expected_signer_address disagrees with prepared buyer`,
    );
  }

  // Principal production gate: configured ≠ access authorized.
  // No provider method may run while access is disabled.
  if (credentialPolicy.credential_access_enabled !== true) {
    assertB31CredentialAccessNotAuthorized();
  }

  const provider =
    input.provider ?? resolveProductiveCredentialProvider(credentialPolicy);

  if (provider.providerId !== credentialPolicy.provider_id) {
    throw new Error(
      `${BLOCKED_B31_PROVIDER_MISMATCH}: selected provider ${provider.providerId} != policy ${credentialPolicy.provider_id}`,
    );
  }
  if (provider.credentialKind !== credentialPolicy.credential_kind) {
    throw new Error(
      `${BLOCKED_B31_PROVIDER_MISMATCH}: selected credential_kind ${provider.credentialKind} != policy ${credentialPolicy.credential_kind}`,
    );
  }

  // Validate credential-access authorization before any provider call.
  assertExplicitProviderSelection({
    policy: credentialPolicy,
    authorizationProviderId: input.credentialAccessAuthorization?.provider_id,
  });
  const accessAuth = validateBuyerCredentialAccessAuthorization({
    authorization: input.credentialAccessAuthorization,
    signingAuthorization: validated.signingAuthorization,
    signingAuthorizationSha256: validated.signingAuthorizationSha256,
    unsignedArtifact: validated.unsignedArtifact,
    unsignedArtifactSha256: validated.unsignedArtifactSha256,
    providerId: provider.providerId,
    credentialKind: provider.credentialKind,
    expectedSignerAddress: expectedFromAuth,
    now: input.now,
  });
  const accessAuthSha256 = buyerCredentialAccessAuthorizationSha256(accessAuth);

  const context: CredentialProviderContext = {
    expectedSignerAddress: expectedFromAuth,
    attemptId: validated.unsignedArtifact.attempt_id,
    runId: validated.unsignedArtifact.run_id,
    unsignedArtifactSha256: validated.unsignedArtifactSha256,
    signingAuthorizationSha256: validated.signingAuthorizationSha256,
  };

  const credentialLedger = input.credentialLedger ?? new BuyerCredentialAccessLedger();
  credentialLedger.assertNotConsumed(accessAuth.decision_id, validated.unsignedArtifactSha256);
  credentialLedger.reserve({
    decisionId: accessAuth.decision_id,
    authorizationSha256: accessAuthSha256,
    unsignedArtifactSha256: validated.unsignedArtifactSha256,
    providerId: provider.providerId,
    now: input.now,
  });
  credentialLedger.persist(
    input.directory,
    accessAuth.decision_id,
    validated.unsignedArtifactSha256,
  );

  // Identity without secrets, before privileged acquire.
  const identity = await provider.resolveSignerIdentity(context);
  if (!sameAddress(identity.address, expectedFromAuth)) {
    throw new Error(
      `${BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH}: provider identity ${identity.address} != expected ${expectedFromAuth}`,
    );
  }

  const stamped = stampAuthorizedCredentialAccessRequest({
    accessAuthorization: accessAuth,
    accessAuthorizationSha256: accessAuthSha256,
    context,
    validated,
  });

  credentialLedger.markAcquisitionInvoked(
    accessAuth.decision_id,
    validated.unsignedArtifactSha256,
    input.now,
  );

  let credentialInput: CredentialBackendInput | undefined =
    input.credentialInput ?? undefined;
  let transportBytes: Uint8Array | null = null;

  if (!credentialInput && input.credentialTransport) {
    if (provider.providerId !== EXPLICIT_RUNTIME_KEY_PROVIDER_ID) {
      credentialLedger.markAmbiguous(
        accessAuth.decision_id,
        validated.unsignedArtifactSha256,
      );
      rejectRuntimeKeyTransportFallback("transport requires explicit-runtime-key");
    }
    const transportAuth = stampAuthorizedCredentialTransportRead({
      transportId: input.credentialTransport.transportId,
      authorizedRequest: stamped,
    });
    try {
      transportBytes = await input.credentialTransport.readOnce(transportAuth);
      credentialInput = {
        kind: "explicit-runtime-key",
        privateKey: transportBytes,
      };
    } catch (error) {
      credentialLedger.markAmbiguous(
        accessAuth.decision_id,
        validated.unsignedArtifactSha256,
      );
      zeroCredentialBytes(transportBytes);
      throw error;
    }
  } else if (!credentialInput && !input.credentialTransport) {
    // No discovery / no env / no argv fallback.
    // Adapter will raise BLOCKED_B33_RUNTIME_KEY_CREDENTIAL_MISSING.
  }

  let signer: BuyerAuthorizationSigner;
  try {
    signer = await provider.acquireSigner(stamped, credentialInput);
  } catch (error) {
    credentialLedger.markAmbiguous(accessAuth.decision_id, validated.unsignedArtifactSha256);
    zeroCredentialBytes(transportBytes);
    throw error;
  } finally {
    zeroCredentialBytes(transportBytes);
    transportBytes = null;
  }

  if (!sameAddress(signer.address, expectedFromAuth)) {
    credentialLedger.markAmbiguous(accessAuth.decision_id, validated.unsignedArtifactSha256);
    throw new Error(
      `${BLOCKED_B32_ACTUAL_SIGNER_IDENTITY_MISMATCH}: acquired signer is not the expected buyer wallet`,
    );
  }

  // Time-of-use: revalidate with a fresh now immediately before signing.
  const nowAtSign = input.nowAtSign ?? new Date();
  const revalidated = prepareValidatedBuyerAuthorizationForSigning({
    unsignedArtifact: input.unsignedArtifact,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
    signingAuthorization: input.signingAuthorization,
    now: nowAtSign,
    expectedUnsignedHash: input.expectedUnsignedHash,
  });
  if (revalidated.unsignedArtifactSha256 !== validated.unsignedArtifactSha256) {
    credentialLedger.markAmbiguous(accessAuth.decision_id, validated.unsignedArtifactSha256);
    throw new Error(
      `${BLOCKED_B31_EXPECTED_SIGNER_IDENTITY_MISMATCH}: revalidation changed unsigned artifact hash`,
    );
  }

  return runAuthorizedBuyerSigning({
    directory: input.directory,
    unsignedArtifact: input.unsignedArtifact,
    attempt: input.attempt,
    humanAuthorization: input.humanAuthorization,
    signingAuthorization: input.signingAuthorization,
    now: nowAtSign,
    signer,
    expectedUnsignedHash: input.expectedUnsignedHash,
    commitSha: input.commitSha,
    policyPath: input.signerPolicyPath,
    cwd: input.cwd,
    returnBeforeSendGateThrow: input.returnBeforeSendGateThrow,
  });
}

/** Explicit productive helper that always asserts the inactive gate. */
export function assertProductionCredentialAccessInactive(): never {
  assertB31CredentialAccessNotAuthorized();
}
