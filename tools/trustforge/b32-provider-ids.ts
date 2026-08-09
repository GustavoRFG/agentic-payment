/**
 * b32-provider-ids — closed productive provider ID set (no implementation deps).
 */

export const B32_PRODUCTIVE_PROVIDER_IDS = [
  "inactive_production",
  "explicit-runtime-key",
  "encrypted-local-keystore",
  "external-signer",
  "secure-signing-provider",
] as const;

export type B32ProductiveProviderId = (typeof B32_PRODUCTIVE_PROVIDER_IDS)[number];

export const B32_SELECTED_PROVIDER_NONE = "NONE" as const;

export const B32_PROVIDER_CREDENTIAL_KINDS: Record<B32ProductiveProviderId, string> = {
  inactive_production: "none",
  "explicit-runtime-key": "explicit_runtime_private_key",
  "encrypted-local-keystore": "encrypted_local_keystore",
  "external-signer": "external_signer",
  "secure-signing-provider": "secure_signing_provider",
};

const PRODUCTIVE_ID_SET = new Set<string>(B32_PRODUCTIVE_PROVIDER_IDS);

export function isB32ProductiveProviderId(id: string): id is B32ProductiveProviderId {
  return PRODUCTIVE_ID_SET.has(id);
}
