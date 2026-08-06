/**
 * b2-activation-policy — versioned prepare-only activation contract.
 *
 * Signing, send, settlement and retry must remain false. The policy alone never
 * authorizes a concrete payment.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID,
  BLOCKED_B2_PREPARE_ACTIVATION_POLICY_MISSING,
} from "./b2-execution-gates";

export const B2_ACTIVATION_POLICY_SCHEMA_VERSION =
  "trustforge_b2_activation_policy.v1" as const;

export const REQUIRED_B2_COMMITS = ["39fe28c", "49c8952"] as const;

export interface B2ActivationPolicy {
  readonly schema_version: typeof B2_ACTIVATION_POLICY_SCHEMA_VERSION;
  readonly decision: "activate_prepare_only";
  readonly prepare_enabled: true;
  readonly real_signing_enabled: false;
  readonly payment_bearing_send_enabled: false;
  readonly settlement_enabled: false;
  readonly retry_enabled: false;
  readonly required_b2_commits: readonly string[];
  readonly audit_result: "PASS_B2_OFFLINE_AUDIT";
  readonly audit_run: string;
  readonly decided_by: string;
  readonly effect: string;
}

export const DEFAULT_B2_ACTIVATION_POLICY_PATH = join(
  "config",
  "trustforge_b2_activation_policy.json",
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function resolveB2ActivationPolicyPath(
  path = DEFAULT_B2_ACTIVATION_POLICY_PATH,
  cwd = process.cwd(),
): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

export function validateB2ActivationPolicy(
  value: unknown,
): { readonly ok: true; readonly policy: B2ActivationPolicy } | { readonly ok: false; readonly reason: string } {
  if (!isRecord(value)) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: policy must be a JSON object`,
    };
  }
  if (value.schema_version !== B2_ACTIVATION_POLICY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: unsupported schema_version`,
    };
  }
  if (value.decision !== "activate_prepare_only") {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: decision must be activate_prepare_only`,
    };
  }
  if (value.prepare_enabled !== true) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: prepare_enabled must be true`,
    };
  }
  if (value.real_signing_enabled !== false) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: real_signing_enabled must be false`,
    };
  }
  if (value.payment_bearing_send_enabled !== false) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: payment_bearing_send_enabled must be false`,
    };
  }
  if (value.settlement_enabled !== false) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: settlement_enabled must be false`,
    };
  }
  if (value.retry_enabled !== false) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: retry_enabled must be false`,
    };
  }
  if (value.audit_result !== "PASS_B2_OFFLINE_AUDIT") {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: audit_result must be PASS_B2_OFFLINE_AUDIT`,
    };
  }
  if (typeof value.audit_run !== "string" || value.audit_run.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: audit_run path is required`,
    };
  }
  if (!Array.isArray(value.required_b2_commits)) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: required_b2_commits must be an array`,
    };
  }
  for (const required of REQUIRED_B2_COMMITS) {
    if (!value.required_b2_commits.map(String).some((c) => c.startsWith(required))) {
      return {
        ok: false,
        reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: missing required commit ${required}`,
      };
    }
  }
  if (typeof value.decided_by !== "string" || value.decided_by.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: decided_by is required`,
    };
  }
  if (typeof value.effect !== "string" || value.effect.trim().length === 0) {
    return {
      ok: false,
      reason: `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: effect is required`,
    };
  }
  return {
    ok: true,
    policy: value as unknown as B2ActivationPolicy,
  };
}

export function loadB2ActivationPolicy(
  path = DEFAULT_B2_ACTIVATION_POLICY_PATH,
  cwd = process.cwd(),
): B2ActivationPolicy {
  const resolved = resolveB2ActivationPolicyPath(path, cwd);
  if (!existsSync(resolved)) {
    throw new Error(
      `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_MISSING}: ${resolved} does not exist`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID}: cannot parse ${resolved}: ${message}`,
    );
  }
  const validated = validateB2ActivationPolicy(parsed);
  if (!validated.ok) {
    throw new Error(validated.reason);
  }
  return validated.policy;
}
