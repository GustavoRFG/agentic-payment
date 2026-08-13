/**
 * payment-candidate-policy — B.5 eligibility (not payment authorization).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  B5_CANDIDATE_POLICY_SCHEMA,
  BLOCKED_B5_CANDIDATE_INELIGIBLE,
  BLOCKED_B5_CANDIDATE_UNSUPPORTED,
  GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED,
} from "./b5-execution-gates";
import { isDomainBlocklisted, loadProviderBlocklist } from "./provider-blocklist";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";
import { paymentCandidateSha256 } from "./payment-candidate-v1";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export type CandidatePolicyVerdictKind =
  | "ELIGIBLE"
  | "INELIGIBLE"
  | "REQUIRES_REVIEW"
  | "UNSUPPORTED"
  | "STALE";

export interface B5CandidatePolicyConfig {
  readonly schema_version: typeof B5_CANDIDATE_POLICY_SCHEMA;
  readonly payment_authorization: false;
  readonly supported_networks: readonly string[];
  readonly supported_assets: readonly string[];
  readonly supported_schemes: readonly string[];
  readonly supported_protocol_versions: readonly number[];
  readonly supported_methods: readonly string[];
  readonly max_single_payment_atomic_by_asset: Readonly<Record<string, string>>;
  readonly min_single_payment_atomic: string;
  readonly max_discovery_age_seconds: number;
  readonly require_request_binding: boolean;
  readonly require_seller_requirements_identity: boolean;
  readonly require_productive_core_compatibility: boolean;
}

export interface CandidatePolicyVerdict {
  readonly schema_version: "trustforge_candidate_policy_verdict.v1";
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly candidate_sha256: string;
  readonly verdict: CandidatePolicyVerdictKind;
  readonly reasons: readonly string[];
  readonly payment_authorized: false;
  readonly policy_sha256: string;
  readonly evaluated_at: string;
}

function defaultPolicyPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../config/trustforge_b5_candidate_policy.json");
}

export function loadB5CandidatePolicy(
  path: string = defaultPolicyPath(),
): B5CandidatePolicyConfig {
  if (!existsSync(path)) {
    throw new Error(`${BLOCKED_B5_CANDIDATE_UNSUPPORTED}: missing policy ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as B5CandidatePolicyConfig;
  if (raw.schema_version !== B5_CANDIDATE_POLICY_SCHEMA) {
    throw new Error(`${BLOCKED_B5_CANDIDATE_UNSUPPORTED}: bad policy schema`);
  }
  if (raw.payment_authorization !== false) {
    throw new Error(
      `${GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED}: policy must not authorize payment`,
    );
  }
  return raw;
}

function hostnameOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function evaluatePaymentCandidatePolicy(
  candidate: PaymentCandidateV1,
  options?: {
    readonly policy?: B5CandidatePolicyConfig;
    readonly now?: Date;
    readonly knownCandidateIds?: ReadonlySet<string>;
  },
): CandidatePolicyVerdict {
  void GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED;
  const policy = options?.policy ?? loadB5CandidatePolicy();
  const now = options?.now ?? new Date();
  const reasons: string[] = [];
  let verdict: CandidatePolicyVerdictKind = "ELIGIBLE";

  const set = (v: CandidatePolicyVerdictKind, reason: string) => {
    reasons.push(reason);
    if (verdict === "ELIGIBLE" || v === "UNSUPPORTED" || v === "STALE") {
      verdict = v;
    } else if (verdict === "REQUIRES_REVIEW" && v === "INELIGIBLE") {
      verdict = v;
    } else if (verdict === "ELIGIBLE") {
      verdict = v;
    }
  };

  if (candidate.protocol !== "x402") {
    set("UNSUPPORTED", "protocol_not_x402");
  }
  if (
    typeof candidate.protocol_version !== "number" ||
    !policy.supported_protocol_versions.includes(candidate.protocol_version)
  ) {
    set("UNSUPPORTED", "unsupported_protocol_version");
  }
  if (
    typeof candidate.scheme !== "string" ||
    !policy.supported_schemes.includes(candidate.scheme)
  ) {
    set("UNSUPPORTED", "unsupported_scheme");
  }
  if (
    typeof candidate.network_canonical !== "string" ||
    !policy.supported_networks.includes(candidate.network_canonical)
  ) {
    set("UNSUPPORTED", "unsupported_network");
  }
  if (
    typeof candidate.asset !== "string" ||
    !policy.supported_assets.map((a) => a.toLowerCase()).includes(candidate.asset.toLowerCase())
  ) {
    set("UNSUPPORTED", "unsupported_asset");
  }
  if (
    candidate.method === "unknown" ||
    !policy.supported_methods.includes(candidate.method)
  ) {
    set("UNSUPPORTED", "unsupported_method");
  }
  if (typeof candidate.amount_atomic !== "string" || !/^\d+$/.test(candidate.amount_atomic)) {
    set("INELIGIBLE", "amount_unparseable");
  } else {
    const amt = BigInt(candidate.amount_atomic);
    if (amt <= 0n) set("INELIGIBLE", "amount_not_positive");
    if (amt < BigInt(policy.min_single_payment_atomic)) {
      set("INELIGIBLE", "amount_below_minimum");
    }
    if (typeof candidate.asset === "string") {
      const cap =
        policy.max_single_payment_atomic_by_asset[candidate.asset] ??
        policy.max_single_payment_atomic_by_asset[
          Object.keys(policy.max_single_payment_atomic_by_asset).find(
            (k) => k.toLowerCase() === candidate.asset.toLowerCase(),
          ) ?? ""
        ];
      if (!cap) set("UNSUPPORTED", "no_asset_cap_configured");
      else if (amt > BigInt(cap)) set("INELIGIBLE", "amount_above_experimental_cap");
    }
  }
  if (typeof candidate.pay_to !== "string" || !isAddress(candidate.pay_to)) {
    set("INELIGIBLE", "invalid_pay_to");
  }
  if (policy.require_request_binding) {
    if (
      typeof candidate.request_binding_identity !== "string" ||
      candidate.request_binding_identity === "unknown" ||
      candidate.request_binding_identity.length < 16
    ) {
      set("INELIGIBLE", "request_binding_missing");
    }
  }
  if (policy.require_seller_requirements_identity) {
    if (
      typeof candidate.seller_requirements_identity !== "string" ||
      candidate.seller_requirements_identity === "unknown" ||
      candidate.seller_requirements_identity.length < 16
    ) {
      set("INELIGIBLE", "seller_requirements_identity_missing");
    }
  }
  if (policy.require_productive_core_compatibility) {
    if (!candidate.execution_selected_candidate) {
      set(
        "REQUIRES_REVIEW",
        "no_execution_selected_candidate_handoff_for_productive_core",
      );
    } else if (candidate.execution_selected_candidate.method &&
      candidate.execution_selected_candidate.method !== "GET") {
      set("UNSUPPORTED", "productive_core_get_only");
    }
  }

  const observedMs = Date.parse(candidate.freshness.observed_at);
  if (!Number.isFinite(observedMs)) {
    set("STALE", "observed_at_unparseable");
  } else {
    const ageSec = (now.getTime() - observedMs) / 1000;
    if (ageSec > policy.max_discovery_age_seconds) {
      set("STALE", "discovery_observation_stale");
    }
    if (ageSec < -300) {
      set("REQUIRES_REVIEW", "observation_in_future");
    }
  }

  if (candidate.endpoint) {
    const blocklist = loadProviderBlocklist();
    if (isDomainBlocklisted(candidate.endpoint, blocklist)) {
      const host = hostnameOf(candidate.endpoint) ?? "unknown";
      set("INELIGIBLE", `provider_blocklisted:${host}`);
    }
  }

  // Duplicate observation of same identity is allowed; selector handles freshness.
  void options?.knownCandidateIds;

  if (verdict !== "ELIGIBLE" && reasons.length === 0) {
    reasons.push(BLOCKED_B5_CANDIDATE_INELIGIBLE);
  }

  return {
    schema_version: "trustforge_candidate_policy_verdict.v1",
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    candidate_sha256: paymentCandidateSha256(candidate),
    verdict,
    reasons,
    payment_authorized: false,
    policy_sha256: canonicalJsonSha256(policy),
    evaluated_at: now.toISOString(),
  };
}

export function policyVerdictSha256(verdict: CandidatePolicyVerdict): string {
  return canonicalJsonSha256(verdict);
}
