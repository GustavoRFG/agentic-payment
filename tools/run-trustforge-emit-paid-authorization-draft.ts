/**
 * run-trustforge-emit-paid-authorization-draft — human-only authorization template writer.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  requestBindingFromSelectedCandidate,
  sellerRequirementsFromSelectedCandidate,
  type DiscoveredSelectedCandidate,
} from "./trustforge/discovered-target-to-selected-candidate";
import { parseUsdcDecimalToAtomic } from "./trustforge/external-x402-get-policy";
import {
  BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
  HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS,
  SIGNED_BUT_NOT_SENT_POLICY,
} from "./trustforge/x402-seller-requirements-binding";
import {
  thinSettlementRequestSummary,
  type ThinSettlementRequestSummary,
} from "./trustforge/thin-settlement-request-binding";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PENDING_HUMAN_DECISION = "PENDING_HUMAN" as const;

export interface HumanPaymentAuthorizationDraft {
  readonly authorization_schema_version: "trustforge_paid_probe_authorization.v3";
  readonly decision: typeof PENDING_HUMAN_DECISION;
  readonly allowed_values: readonly ["reject", "authorize_one_payment"];
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  /** Verb the human is authorizing; must match the candidate at settle time. */
  readonly method: string;
  readonly request_binding_sha256: string;
  readonly request_summary: ThinSettlementRequestSummary;
  readonly canonical_requirements_sha256: string;
  readonly canonical_envelope_sha256: string;
  readonly x402_version: 1 | 2;
  readonly scheme: string;
  readonly seller_network_raw: string;
  readonly canonical_network_caip2: string;
  /** Operational alias, exactly equal to canonical_network_caip2. */
  readonly network: string;
  readonly asset: string;
  readonly pay_to: string;
  readonly amount_atomic: string;
  readonly maximum_authorized_amount_atomic: string;
  readonly buyer_wallet: string;
  readonly max_usdc: string;
  readonly max_payment_attempts: 1;
  readonly allow_retry: false;
  readonly require_dedicated_wallet: true;
  readonly rationale: string;
  readonly decided_at: null;
  readonly authorization_ttl_seconds: typeof HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS;
  readonly authorization_expires_at: null;
  readonly buyer_nonce_policy: "cryptographic_random_32_bytes_per_attempt";
  readonly buyer_validity_policy: {
    readonly valid_after_clock_skew_seconds: typeof BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS;
    readonly valid_before_must_not_exceed: "effective_signing_deadline";
    readonly signed_but_not_sent: typeof SIGNED_BUT_NOT_SENT_POLICY;
  };
  readonly requirements_refresh_policy: "exact_hash_match_before_signing";
  readonly target_selection_audit: DiscoveredSelectedCandidate["target_selection_audit"];
}

export function buildHumanPaymentAuthorizationDraft(
  candidate: DiscoveredSelectedCandidate,
): HumanPaymentAuthorizationDraft {
  const requestBinding = requestBindingFromSelectedCandidate(candidate);
  const requirements = sellerRequirementsFromSelectedCandidate(candidate).binding;
  return {
    authorization_schema_version: "trustforge_paid_probe_authorization.v3",
    decision: PENDING_HUMAN_DECISION,
    allowed_values: ["reject", "authorize_one_payment"],
    provider: candidate.provider,
    service_id: candidate.service_id,
    endpoint: candidate.endpoint,
    method: requestBinding.method,
    request_binding_sha256: requestBinding.binding_sha256,
    request_summary: thinSettlementRequestSummary(requestBinding),
    canonical_requirements_sha256: requirements.canonical_requirements_sha256,
    canonical_envelope_sha256: requirements.canonical_envelope_sha256,
    x402_version: requirements.protocol_version,
    scheme: requirements.scheme,
    seller_network_raw: requirements.seller_network_raw,
    canonical_network_caip2: requirements.canonical_network_caip2,
    network: requirements.canonical_network_caip2,
    asset: requirements.asset,
    pay_to: requirements.pay_to,
    amount_atomic: requirements.amount_atomic,
    maximum_authorized_amount_atomic: parseUsdcDecimalToAtomic(
      candidate.recommended_max_usdc,
    ).toString(),
    buyer_wallet: candidate.buyer_wallet,
    max_usdc: candidate.recommended_max_usdc,
    max_payment_attempts: 1,
    allow_retry: false,
    require_dedicated_wallet: true,
    rationale: "",
    decided_at: null,
    authorization_ttl_seconds: HUMAN_AUTHORIZATION_DEFAULT_TTL_SECONDS,
    authorization_expires_at: null,
    buyer_nonce_policy: "cryptographic_random_32_bytes_per_attempt",
    buyer_validity_policy: {
      valid_after_clock_skew_seconds: BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
      valid_before_must_not_exceed: "effective_signing_deadline",
      signed_but_not_sent: SIGNED_BUT_NOT_SENT_POLICY,
    },
    requirements_refresh_policy: "exact_hash_match_before_signing",
    target_selection_audit: candidate.target_selection_audit,
  };
}

export function assertDraftDecisionIsPending(
  decision: string,
): asserts decision is typeof PENDING_HUMAN_DECISION {
  if (decision !== PENDING_HUMAN_DECISION) {
    throw new Error(
      `BLOCKED_AUTHORIZATION_DRAFT_DECISION: generator only writes decision=${PENDING_HUMAN_DECISION}`,
    );
  }
}

export async function writeHumanPaymentAuthorizationDraft(input: {
  readonly candidate: DiscoveredSelectedCandidate;
  readonly outputPath: string;
}): Promise<HumanPaymentAuthorizationDraft> {
  const draft = buildHumanPaymentAuthorizationDraft(input.candidate);
  assertDraftDecisionIsPending(draft.decision);
  await writeFile(input.outputPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  return draft;
}

async function main(): Promise<number> {
  const selectedArg = process.argv.indexOf("--selected-candidate");
  const outputArg = process.argv.indexOf("--output");
  if (selectedArg < 0 || outputArg < 0) {
    console.error(
      "Usage: tsx tools/run-trustforge-emit-paid-authorization-draft.ts --selected-candidate <path> --output <path>",
    );
    return 1;
  }

  const selectedPath = process.argv[selectedArg + 1];
  const outputPath = process.argv[outputArg + 1];
  const candidate = JSON.parse(await readFile(selectedPath, "utf8")) as DiscoveredSelectedCandidate;
  await writeHumanPaymentAuthorizationDraft({ candidate, outputPath });
  console.log(`human_payment_authorization.DRAFT.json: ${outputPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { REPO as EMIT_PAID_AUTHORIZATION_DRAFT_REPO };
