/**
 * b31-credential-provider-policy — versioned credential-provider readiness.
 *
 * Configured ≠ access authorized. B.3.2 extends this policy with an explicit
 * provider registry (allowed IDs, selected productive provider, backend flags).
 * Production keeps credential_access_enabled and real_backend_activation false.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID,
  BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_MISSING,
} from "./b31-execution-gates";
import { BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID } from "./b32-execution-gates";
import {
  B32_PRODUCTIVE_PROVIDER_IDS,
  B32_SELECTED_PROVIDER_NONE,
} from "./b32-provider-ids";

export const B31_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION =
  "trustforge_buyer_credential_provider_policy.v1" as const;
export const B32_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION =
  "trustforge_buyer_credential_provider_policy.v2" as const;

export interface B31CredentialProviderPolicy {
  readonly schema_version:
    | typeof B31_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION
    | typeof B32_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION;
  readonly credential_provider_configured: true;
  readonly allowed_provider_ids: readonly string[];
  readonly selected_productive_provider_id: string;
  readonly provider_id: string;
  readonly credential_kind: string;
  /** When true, the selected provider adapter module is installed (may still be access-disabled). */
  readonly adapter_installed: boolean;
  /** When true, one-shot credential pipe transport is installed (access may still be disabled). */
  readonly transport_adapter_installed: boolean;
  /** Optional non-secret public address binding from policy; may be null. */
  readonly expected_signer_address: string | null;
  readonly credential_access_enabled: boolean;
  readonly real_backend_activation: false;
  readonly credential_caching_enabled: false;
  readonly automatic_discovery_enabled: false;
  readonly fallback_provider_enabled: false;
  readonly real_signing_enabled: false;
  readonly payment_bearing_send_enabled: false;
  readonly settlement_enabled: false;
  readonly retry_enabled: false;
  readonly effect: string;
}

export const DEFAULT_B31_CREDENTIAL_PROVIDER_POLICY_PATH = join(
  "config",
  "trustforge_buyer_credential_provider_policy.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolveB31CredentialProviderPolicyPath(
  path = DEFAULT_B31_CREDENTIAL_PROVIDER_POLICY_PATH,
  cwd = process.cwd(),
): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function normalizeAllowedProviderIds(
  value: unknown,
  providerId: string,
):
  | { readonly ok: true; readonly ids: readonly string[] }
  | { readonly ok: false; readonly reason: string } {
  if (value === undefined) {
    // v1 compatibility: allow only the configured provider_id.
    return { ok: true, ids: [providerId] };
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every((x) => typeof x === "string" && x.trim().length > 0)) {
    return {
      ok: false,
      reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: allowed_provider_ids must be a non-empty string array`,
    };
  }
  return { ok: true, ids: value as string[] };
}

export function validateB31CredentialProviderPolicy(
  value: unknown,
):
  | { readonly ok: true; readonly policy: B31CredentialProviderPolicy }
  | { readonly ok: false; readonly reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: policy must be a JSON object`,
    };
  }
  const schema = value.schema_version;
  if (
    schema !== B31_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION &&
    schema !== B32_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION
  ) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: unsupported schema_version`,
    };
  }
  if (value.credential_provider_configured !== true) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: credential_provider_configured must be true for readiness`,
    };
  }
  if (typeof value.provider_id !== "string" || value.provider_id.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: provider_id is required`,
    };
  }
  if (typeof value.credential_kind !== "string" || value.credential_kind.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: credential_kind is required`,
    };
  }
  if (
    value.expected_signer_address !== null &&
    (typeof value.expected_signer_address !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(value.expected_signer_address))
  ) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: expected_signer_address must be null or a 20-byte address`,
    };
  }
  if (typeof value.credential_access_enabled !== "boolean") {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: credential_access_enabled must be boolean`,
    };
  }
  const adapterInstalled =
    value.adapter_installed === undefined ? false : value.adapter_installed;
  if (typeof adapterInstalled !== "boolean") {
    return {
      ok: false,
      reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: adapter_installed must be boolean when present`,
    };
  }
  const transportAdapterInstalled =
    value.transport_adapter_installed === undefined
      ? false
      : value.transport_adapter_installed;
  if (typeof transportAdapterInstalled !== "boolean") {
    return {
      ok: false,
      reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: transport_adapter_installed must be boolean when present`,
    };
  }

  const allowed = normalizeAllowedProviderIds(value.allowed_provider_ids, value.provider_id);
  if (!allowed.ok) {
    return allowed;
  }
  if (!allowed.ids.includes(value.provider_id)) {
    return {
      ok: false,
      reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: provider_id must be listed in allowed_provider_ids`,
    };
  }

  const selected =
    value.selected_productive_provider_id === undefined
      ? B32_SELECTED_PROVIDER_NONE
      : value.selected_productive_provider_id;
  if (
    typeof selected !== "string" ||
    (selected !== B32_SELECTED_PROVIDER_NONE && !allowed.ids.includes(selected))
  ) {
    return {
      ok: false,
      reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: selected_productive_provider_id must be NONE or an allowed provider id`,
    };
  }

  // Production registry IDs are closed; test policies may list synthetic.
  for (const id of allowed.ids) {
    if (
      id !== "synthetic" &&
      !(B32_PRODUCTIVE_PROVIDER_IDS as readonly string[]).includes(id)
    ) {
      return {
        ok: false,
        reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: unknown allowed provider id ${id}`,
      };
    }
  }

  const mustBeFalse = [
    "automatic_discovery_enabled",
    "fallback_provider_enabled",
    "real_signing_enabled",
    "payment_bearing_send_enabled",
    "settlement_enabled",
    "retry_enabled",
  ] as const;
  for (const key of mustBeFalse) {
    if (value[key] !== false) {
      return {
        ok: false,
        reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: ${key} must be false`,
      };
    }
  }

  const realBackend =
    value.real_backend_activation === undefined ? false : value.real_backend_activation;
  if (realBackend !== false) {
    return {
      ok: false,
      reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: real_backend_activation must be false`,
    };
  }
  const caching =
    value.credential_caching_enabled === undefined
      ? false
      : value.credential_caching_enabled;
  if (caching !== false) {
    return {
      ok: false,
      reason: `${BLOCKED_B32_CREDENTIAL_PROVIDER_POLICY_INVALID}: credential_caching_enabled must be false`,
    };
  }

  if (typeof value.effect !== "string" || value.effect.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: effect is required`,
    };
  }

  const policy: B31CredentialProviderPolicy = {
    schema_version: schema,
    credential_provider_configured: true,
    allowed_provider_ids: allowed.ids,
    selected_productive_provider_id: selected,
    provider_id: value.provider_id,
    credential_kind: value.credential_kind,
    adapter_installed: adapterInstalled,
    transport_adapter_installed: transportAdapterInstalled,
    expected_signer_address: value.expected_signer_address as string | null,
    credential_access_enabled: value.credential_access_enabled,
    real_backend_activation: false,
    credential_caching_enabled: false,
    automatic_discovery_enabled: false,
    fallback_provider_enabled: false,
    real_signing_enabled: false,
    payment_bearing_send_enabled: false,
    settlement_enabled: false,
    retry_enabled: false,
    effect: value.effect,
  };
  return { ok: true, policy };
}

export function loadB31CredentialProviderPolicy(
  path = DEFAULT_B31_CREDENTIAL_PROVIDER_POLICY_PATH,
  cwd = process.cwd(),
): B31CredentialProviderPolicy {
  const resolved = resolveB31CredentialProviderPolicyPath(path, cwd);
  if (!existsSync(resolved)) {
    throw new Error(
      `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_MISSING}: ${resolved} does not exist`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: cannot parse ${resolved}: ${message}`,
    );
  }
  const validated = validateB31CredentialProviderPolicy(parsed);
  if (!validated.ok) {
    throw new Error(validated.reason);
  }
  return validated.policy;
}
