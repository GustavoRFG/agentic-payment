/**
 * buyer-credential-provider-registry — explicit provider IDs only.
 *
 * Interface (B.3.1) stays stable. Implementations are selected by exact ID
 * from policy + credential-access authorization. No implicit fallback.
 */

import {
  BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS,
  BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN,
  assertB32RealCredentialBackendInactive,
} from "./b32-execution-gates";
import {
  B32_PRODUCTIVE_PROVIDER_IDS,
  B32_PROVIDER_CREDENTIAL_KINDS,
  B32_SELECTED_PROVIDER_NONE,
  isB32ProductiveProviderId,
  type B32ProductiveProviderId,
} from "./b32-provider-ids";
import type { B31CredentialProviderPolicy } from "./b31-credential-provider-policy";
import {
  createInactiveEncryptedLocalKeystoreProvider,
  createInactiveExplicitRuntimeKeyProvider,
  createInactiveExternalSignerProvider,
  createInactiveSecureSigningProvider,
} from "./buyer-credential-provider-adapters";
import type { CredentialBackendInput } from "./buyer-credential-backend-types";
import {
  createInactiveProductionCredentialProvider,
  type BuyerCredentialProvider,
} from "./buyer-credential-provider";

export {
  B32_PRODUCTIVE_PROVIDER_IDS,
  B32_PROVIDER_CREDENTIAL_KINDS,
  B32_SELECTED_PROVIDER_NONE,
  isB32ProductiveProviderId,
};
export type { B32ProductiveProviderId, CredentialBackendInput };

export function assertExplicitProviderSelection(input: {
  readonly policy: B31CredentialProviderPolicy;
  readonly authorizationProviderId?: string | null;
}): void {
  const policy = input.policy;
  if (policy.fallback_provider_enabled !== false) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS}: fallback_provider_enabled must be false`,
    );
  }
  if (policy.automatic_discovery_enabled !== false) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS}: automatic_discovery_enabled must be false`,
    );
  }

  const configured = policy.provider_id;
  if (!policy.allowed_provider_ids.includes(configured)) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN}: configured provider_id ${configured} is not in allowed_provider_ids`,
    );
  }

  const selected = policy.selected_productive_provider_id;
  if (selected !== B32_SELECTED_PROVIDER_NONE && selected !== configured) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS}: selected_productive_provider_id ${selected} disagrees with configured provider_id ${configured}`,
    );
  }

  if (
    input.authorizationProviderId != null &&
    input.authorizationProviderId !== configured
  ) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS}: credential-access authorization provider_id ${input.authorizationProviderId} != configured ${configured}`,
    );
  }
}

/**
 * Resolve the productive provider adapter for the exact configured ID.
 * Real backends are inactive shells that fail before secret access.
 */
export function resolveProductiveCredentialProvider(
  policy: B31CredentialProviderPolicy,
): BuyerCredentialProvider {
  assertExplicitProviderSelection({ policy });

  const id = policy.provider_id;
  if (!isB32ProductiveProviderId(id)) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN}: provider_id ${id} is not a registered productive provider`,
    );
  }

  const expectedKind = B32_PROVIDER_CREDENTIAL_KINDS[id];
  if (policy.credential_kind !== expectedKind) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS}: credential_kind ${policy.credential_kind} does not match registry kind ${expectedKind} for ${id}`,
    );
  }

  switch (id) {
    case "inactive_production":
      return createInactiveProductionCredentialProvider({
        providerId: id,
        credentialKind: expectedKind,
        policyExpectedSignerAddress: policy.expected_signer_address,
      });
    case "explicit-runtime-key":
      return createInactiveExplicitRuntimeKeyProvider();
    case "encrypted-local-keystore":
      return createInactiveEncryptedLocalKeystoreProvider();
    case "external-signer":
      return createInactiveExternalSignerProvider();
    case "secure-signing-provider":
      return createInactiveSecureSigningProvider();
    default: {
      const _exhaustive: never = id;
      throw new Error(
        `${BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN}: unhandled provider ${_exhaustive}`,
      );
    }
  }
}

/** Test helper: prove unknown IDs cannot be resolved. */
export function rejectUnknownProviderId(providerId: string): never {
  throw new Error(
    `${BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN}: provider_id ${providerId} is not registered`,
  );
}

/**
 * Future activation check — productive real backends stay blocked while
 * real_backend_activation is false.
 */
export function assertRealBackendActivationAllowed(
  policy: B31CredentialProviderPolicy,
  providerId: string,
): void {
  if (policy.real_backend_activation !== true) {
    assertB32RealCredentialBackendInactive(providerId);
  }
  if (policy.selected_productive_provider_id === B32_SELECTED_PROVIDER_NONE) {
    assertB32RealCredentialBackendInactive(providerId);
  }
  if (policy.credential_caching_enabled !== false) {
    throw new Error(
      `${BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS}: credential_caching_enabled must remain false`,
    );
  }
}
