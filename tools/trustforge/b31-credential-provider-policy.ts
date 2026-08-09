/**
 * b31-credential-provider-policy — versioned credential-provider readiness.
 *
 * Configured ≠ access authorized. This phase keeps credential_access_enabled false.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID,
  BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_MISSING,
} from "./b31-execution-gates";

export const B31_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION =
  "trustforge_buyer_credential_provider_policy.v1" as const;

export interface B31CredentialProviderPolicy {
  readonly schema_version: typeof B31_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION;
  readonly credential_provider_configured: true;
  readonly provider_id: string;
  readonly credential_kind: string;
  /** Optional non-secret public address binding from policy; may be null. */
  readonly expected_signer_address: string | null;
  readonly credential_access_enabled: boolean;
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
  if (value.schema_version !== B31_CREDENTIAL_PROVIDER_POLICY_SCHEMA_VERSION) {
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
  if (typeof value.effect !== "string" || value.effect.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B31_CREDENTIAL_PROVIDER_POLICY_INVALID}: effect is required`,
    };
  }
  return { ok: true, policy: value as unknown as B31CredentialProviderPolicy };
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
