/**
 * b3-signer-activation-policy — versioned signer adapter readiness contract.
 *
 * Adapter may be installed while real signing remains false. Never authorizes
 * credential acquisition or payment-bearing send by itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID,
  BLOCKED_B3_SIGNER_ACTIVATION_POLICY_MISSING,
} from "./b3-execution-gates";

export const B3_SIGNER_ACTIVATION_POLICY_SCHEMA_VERSION =
  "trustforge_signer_activation_policy.v1" as const;

export interface B3SignerActivationPolicy {
  readonly schema_version: typeof B3_SIGNER_ACTIVATION_POLICY_SCHEMA_VERSION;
  readonly signer_adapter_installed: true;
  readonly real_signing_enabled: false;
  readonly automatic_wallet_discovery: false;
  readonly wallet_env_loading_enabled: false;
  readonly credential_provider_enabled: false;
  readonly payment_bearing_send_enabled: false;
  readonly settlement_enabled: false;
  readonly retry_enabled: false;
  readonly effect: string;
}

export const DEFAULT_B3_SIGNER_ACTIVATION_POLICY_PATH = join(
  "config",
  "trustforge_signer_activation_policy.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolveB3SignerActivationPolicyPath(
  path = DEFAULT_B3_SIGNER_ACTIVATION_POLICY_PATH,
  cwd = process.cwd(),
): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

export function validateB3SignerActivationPolicy(
  value: unknown,
):
  | { readonly ok: true; readonly policy: B3SignerActivationPolicy }
  | { readonly ok: false; readonly reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: `${BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID}: policy must be a JSON object`,
    };
  }
  if (value.schema_version !== B3_SIGNER_ACTIVATION_POLICY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `${BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID}: unsupported schema_version`,
    };
  }
  if (value.signer_adapter_installed !== true) {
    return {
      ok: false,
      reason: `${BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID}: signer_adapter_installed must be true for readiness`,
    };
  }
  const mustBeFalse = [
    "real_signing_enabled",
    "automatic_wallet_discovery",
    "wallet_env_loading_enabled",
    "credential_provider_enabled",
    "payment_bearing_send_enabled",
    "settlement_enabled",
    "retry_enabled",
  ] as const;
  for (const key of mustBeFalse) {
    if (value[key] !== false) {
      return {
        ok: false,
        reason: `${BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID}: ${key} must be false`,
      };
    }
  }
  if (typeof value.effect !== "string" || value.effect.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID}: effect is required`,
    };
  }
  return { ok: true, policy: value as unknown as B3SignerActivationPolicy };
}

export function loadB3SignerActivationPolicy(
  path = DEFAULT_B3_SIGNER_ACTIVATION_POLICY_PATH,
  cwd = process.cwd(),
): B3SignerActivationPolicy {
  const resolved = resolveB3SignerActivationPolicyPath(path, cwd);
  if (!existsSync(resolved)) {
    throw new Error(
      `${BLOCKED_B3_SIGNER_ACTIVATION_POLICY_MISSING}: ${resolved} does not exist`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${BLOCKED_B3_SIGNER_ACTIVATION_POLICY_INVALID}: cannot parse ${resolved}: ${message}`,
    );
  }
  const validated = validateB3SignerActivationPolicy(parsed);
  if (!validated.ok) {
    throw new Error(validated.reason);
  }
  return validated.policy;
}
