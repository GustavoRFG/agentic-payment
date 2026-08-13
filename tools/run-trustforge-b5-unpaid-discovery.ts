/**
 * run-trustforge-b5-unpaid-discovery — LIVE READ-ONLY / unpaid candidate recon (B.5).
 *
 * NO payment header, NO signer, NO credential access, NO paid request.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT } from "./trustforge/b5-execution-gates";
import { BazaarClient } from "./trustforge/bazaar-client";
import { assessPaymentCandidateEconomics } from "./trustforge/payment-candidate-economics";
import { normalizeFromDiscoveredSelectedCandidate } from "./trustforge/payment-candidate-normalize";
import {
  evaluatePaymentCandidatePolicy,
  loadB5CandidatePolicy,
} from "./trustforge/payment-candidate-policy";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { runTargetResolution } from "./trustforge/target-resolution";
import { canonicalJsonSha256 } from "./trustforge/x402-seller-requirements-binding";
/** Planning-only placeholder; unpaid discovery never signs or pays. */
const PLANNING_BUYER_PLACEHOLDER =
  "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1";

function readArg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : undefined;
}

function handshakeToSelected(
  outcome: {
    readonly candidateId: string;
    readonly resourceUrl: string;
    readonly status: string;
    readonly sellerRequirements: DiscoveredSelectedCandidate["seller_requirements"] | null;
    readonly quoteAtomic: string | null;
    readonly quoteUsdc: string | null;
    readonly selectedAccept: {
      readonly scheme: string;
      readonly network: string;
      readonly asset: string;
      readonly amountAtomic: string;
      readonly payTo: string | null;
      readonly maxTimeoutSeconds: number | null;
      readonly canonicalNetworkCaip2?: string;
      readonly sellerNetworkRaw?: string;
    } | null;
  },
  candidateMeta: {
    readonly method: "GET" | "POST";
    readonly requestBinding: {
      readonly endpoint: string;
      readonly query: readonly (readonly [string, string])[];
      readonly body: DiscoveredSelectedCandidate["request_body"];
      readonly binding_sha256: string;
    } | null;
    readonly requestInputProvenance: DiscoveredSelectedCandidate["request_input_provenance"] | null;
  },
  nowIso: string,
): DiscoveredSelectedCandidate | null {
  if (outcome.status !== "live_402_ok" || !outcome.sellerRequirements || !outcome.selectedAccept) {
    return null;
  }
  const obs = outcome.sellerRequirements;
  const accept = outcome.selectedAccept;
  const binding = obs.binding;
  const rb = candidateMeta.requestBinding;
  const provenance = candidateMeta.requestInputProvenance;
  if (!rb || !provenance) {
    return null;
  }
  const method = candidateMeta.method === "POST" ? "POST" : "GET";
  const network =
    accept.canonicalNetworkCaip2 ??
    binding.canonical_network_caip2 ??
    "eip155:8453";
  return {
    schema_version: "trustforge_selected_candidate.v3",
    provider: "bazaar_unpaid",
    service_id: outcome.candidateId,
    endpoint: rb.endpoint,
    method,
    request_input_status: "known",
    request_query: rb.query.map(([k, v]) => [k, v] as [string, string]),
    request_body: rb.body,
    request_input_provenance: provenance,
    request_binding_sha256: rb.binding_sha256,
    protocol_version: binding.protocol_version,
    transport: binding.transport,
    scheme: accept.scheme,
    amount_field: binding.amount_field,
    max_timeout_seconds: accept.maxTimeoutSeconds ?? binding.max_timeout_seconds,
    resource: binding.resource,
    extra: binding.extra,
    canonical_requirements_sha256: binding.canonical_requirements_sha256,
    canonical_envelope_sha256: binding.canonical_envelope_sha256,
    selection_requirements_observed_at: obs.requirements_observed_at,
    ancillary_tempo_evidence: obs.ancillary_tempo_evidence,
    seller_requirements: obs,
    quote_amount_usdc: outcome.quoteUsdc ?? "unknown",
    quote_atomic: outcome.quoteAtomic ?? accept.amountAtomic,
    authorized_pay_to: accept.payTo ?? binding.pay_to,
    recommended_max_usdc: "0.005",
    seller_network_raw: accept.sellerNetworkRaw ?? binding.seller_network_raw,
    canonical_network_caip2: network,
    network,
    asset: accept.asset,
    buyer_wallet: PLANNING_BUYER_PLACEHOLDER,
    target_selection_audit: {
      selected_resource_url: outcome.resourceUrl,
      handshake_status: outcome.status,
      fallback_resource_urls: [],
      scoring_rationale: ["b5_unpaid_discovery"],
    },
    selected_at_utc: nowIso,
  };
}

async function main(): Promise<number> {
  void GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT;
  const runDir = readArg("--run-dir");
  if (!runDir) {
    console.error("Usage: tsx tools/run-trustforge-b5-unpaid-discovery.ts --run-dir <path>");
    return 1;
  }
  mkdirSync(runDir, { recursive: true });
  const now = new Date();
  const nowIso = now.toISOString();
  const policy = loadB5CandidatePolicy();
  const usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

  const report = await runTargetResolution({
    bazaarClient: new BazaarClient(),
    maxTargetPriceAtomic: policy.max_single_payment_atomic_by_asset[usdc],
  });

  const metaById = new Map(
    report.candidates.map((c) => [
      c.candidateId,
      {
        method: (c.method === "POST" ? "POST" : "GET") as "GET" | "POST",
        requestBinding: c.requestBinding,
        requestInputProvenance: c.requestInputProvenance,
      },
    ] as const),
  );

  const evaluated = [];
  for (const hs of report.handshakeOutcomes) {
    const meta = metaById.get(hs.candidateId) ?? {
      method: "GET" as const,
      requestBinding: null,
      requestInputProvenance: null,
    };
    const selected = handshakeToSelected(hs, meta, nowIso);
    if (!selected) continue;
    const candidate = normalizeFromDiscoveredSelectedCandidate(selected, {
      discovery_source: "bazaar_unpaid_handshake",
      discovered_at: nowIso,
      purpose: "unknown",
    });
    const verdict = evaluatePaymentCandidatePolicy(candidate, { policy, now });
    const economics = assessPaymentCandidateEconomics(candidate, verdict, { now });
    evaluated.push({
      observed_at: nowIso,
      endpoint: candidate.endpoint,
      method: candidate.method,
      http_handshake_status: hs.status,
      http_status: hs.httpStatus,
      network: candidate.network_canonical,
      asset: candidate.asset,
      amount_atomic: candidate.amount_atomic,
      pay_to: candidate.pay_to,
      seller_requirements_hash: candidate.seller_requirements_identity,
      candidate_id: candidate.candidate_id,
      normalization_status: candidate.status,
      policy_verdict: verdict.verdict,
      policy_reasons: verdict.reasons,
      economic_assessment: {
        cost_atomic: economics.cost_atomic,
        utility_confidence: economics.utility_confidence,
        risk_flags: economics.risk_flags,
      },
      candidate,
      verdict,
      economics,
    });
  }

  const onesource = evaluated.filter((e) =>
    e.endpoint.includes("api.onesource.io"),
  );
  const nonOneSourceEligible = evaluated
    .filter(
      (e) =>
        !e.endpoint.includes("api.onesource.io") && e.policy_verdict === "ELIGIBLE",
    )
    .sort((a, b) =>
      String(a.economics.cost_rank_key).localeCompare(String(b.economics.cost_rank_key)),
    );

  const second = nonOneSourceEligible[0] ?? null;
  const weakDiversity = evaluated.filter(
    (e) =>
      e.endpoint.includes("api.onesource.io") &&
      e.endpoint !== "https://api.onesource.io/api/chain/block-number",
  );

  const result = {
    schema_version: "trustforge_b5_live_unpaid_discovery.v1",
    observed_at: nowIso,
    payment_authorized: false,
    discovery_ok: report.discovery.ok,
    handshake_ok_count: report.handshakeOutcomes.filter((h) => h.status === "live_402_ok")
      .length,
    evaluated_count: evaluated.length,
    onesource_count: onesource.length,
    weak_diversity_onesource_other_endpoints: weakDiversity.map((w) => w.endpoint),
    second_live_candidate: second
      ? {
          status: "FOUND",
          provider: second.candidate.provider_id,
          service: second.candidate.service_id,
          endpoint: second.candidate.endpoint,
          method: second.candidate.method,
          purpose: second.candidate.expected_utility.purpose,
          network: second.candidate.network_canonical,
          asset: second.candidate.asset,
          amount_atomic: second.candidate.amount_atomic,
          amount_display: second.candidate.amount_display,
          pay_to: second.candidate.pay_to,
          policy_verdict: second.policy_verdict,
          selection_rationale: [
            "lowest_cost_non_onesource_ELIGIBLE_after_unpaid_handshake",
            `cost_atomic=${second.economics.cost_atomic}`,
          ],
          main_risks: second.economics.risk_flags,
        }
      : { status: "NO_SECOND_LIVE_CANDIDATE_FOUND" },
    recommended_for_human_review: second
      ? {
          label: "RECOMMENDED_B5_DIVERSITY_CANDIDATE",
          ...second,
          candidate: undefined,
          verdict: undefined,
          economics: undefined,
        }
      : null,
    checkpoint: {
      human_review_required: true,
      payment_dialog_opened: false,
      real_payment_authorized: false,
      approve_reject_dialog: "NOT_OPENED",
    },
    safety: report.safety,
    report_sha256: canonicalJsonSha256({
      evaluated: evaluated.length,
      second: second?.candidate_id ?? null,
    }),
  };

  writeFileSync(
    join(runDir, "live_unpaid_discovery.json"),
    `${JSON.stringify(
      {
        result: {
          ...result,
          recommended_for_human_review: second
            ? {
                status: "FOUND",
                provider: second.candidate.provider_id,
                service: second.candidate.service_id,
                endpoint: second.candidate.endpoint,
                method: second.candidate.method,
                purpose: second.candidate.expected_utility.purpose,
                network: second.candidate.network_canonical,
                asset: second.candidate.asset,
                amount: second.candidate.amount_display,
                amount_atomic: second.candidate.amount_atomic,
                payTo: second.candidate.pay_to,
                policy_verdict: second.policy_verdict,
                selection_rationale: result.second_live_candidate.status === "FOUND"
                  ? result.second_live_candidate.selection_rationale
                  : [],
                main_risks: second.economics.risk_flags,
              }
            : null,
        },
        evaluated_summary: evaluated.map((e) => ({
          endpoint: e.endpoint,
          amount_atomic: e.amount_atomic,
          policy_verdict: e.policy_verdict,
          reasons: e.policy_reasons,
        })),
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(runDir, "candidate_checkpoint.json"),
    `${JSON.stringify(
      {
        ...result.checkpoint,
        second_live_candidate: result.second_live_candidate,
        onesource_reference: {
          endpoint: "https://api.onesource.io/api/chain/block-number",
          note: "Known B4-proven candidate; not re-authorized by this recon",
        },
      },
      null,
      2,
    )}\n`,
  );

  console.log(`evaluated=${evaluated.length}`);
  console.log(`second=${result.second_live_candidate.status}`);
  console.log("NO_PAYMENT");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
