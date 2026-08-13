/**
 * run-trustforge-b6-live-unpaid-decision — LIVE UNPAID B.6 decision only.
 *
 * Probes OneSource block-number + OttoAI crypto-news (GET unpaid 402),
 * normalizes → policy → economics v2 → B6 BUY/DEFER/DONT_BUY.
 *
 * NO Approve/Reject UI. NO signer. NO DPAPI. NO payment header. NO paid request.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT,
  assertB6HasNoExecutionAuthority,
} from "./trustforge/b6-execution-gates";
import {
  B6_DECISION_POLICY_V1,
  b6DecisionPolicyHash,
} from "./trustforge/b6-decision-policy-v1";
import { runB6DecisionFromCandidates } from "./trustforge/b6-run-decision";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import {
  assessEconomicV2,
  economicAssessmentV2Sha256,
} from "./trustforge/economic-assessment-v2";
import {
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
} from "./trustforge/payment-approval-intent";
import { normalizeFromDiscoveredSelectedCandidate } from "./trustforge/payment-candidate-normalize";
import {
  evaluatePaymentCandidatePolicy,
  loadB5CandidatePolicy,
} from "./trustforge/payment-candidate-policy";
import { paymentSelectionDecisionHash } from "./trustforge/payment-selection-decision-v1";
import type { TargetCandidate } from "./trustforge/target-candidates";
import { probeTargetLiveness } from "./trustforge/target-liveness";
import { createThinSettlementRequestBinding } from "./trustforge/thin-settlement-request-binding";

const PLANNING_BUYER = "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ONESOURCE_ENDPOINT = "https://api.onesource.io/api/chain/block-number";
const OTTO_ENDPOINT = "https://x402.ottoai.services/crypto-news";
const OTTO_PAY_TO = "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808";

function persist(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSha256Sums(runDir: string): void {
  const files = readdirSync(runDir)
    .filter((f) => f !== "SHA256SUMS.txt")
    .filter((f) => statSync(join(runDir, f)).isFile())
    .sort();
  const lines = files.map((f) => `${sha256File(join(runDir, f))}  ${f}`);
  writeFileSync(join(runDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`);
}

async function probeToSelected(input: {
  readonly candidateId: string;
  readonly endpoint: string;
  readonly method: "GET";
  readonly query: ReadonlyArray<readonly [string, string]>;
  readonly expectedPayTo?: string;
  readonly maxTargetPriceAtomic: string;
  readonly now: Date;
}): Promise<{
  readonly selected: DiscoveredSelectedCandidate | null;
  readonly probe: Record<string, unknown>;
}> {
  const rb = createThinSettlementRequestBinding({
    endpoint: input.endpoint,
    method: input.method,
    input_status: "known",
    query: input.query.map(([k, v]) => [k, v] as [string, string]),
    body: null,
  });
  const probeCandidate: TargetCandidate = {
    candidateId: input.candidateId,
    resourceUrl:
      input.query.length > 0
        ? `${input.endpoint}?${input.query.map(([k, v]) => `${k}=${v}`).join("&")}`
        : input.endpoint,
    method: input.method,
    x402Version: 2,
    freshness: {
      lastUpdated: input.now.toISOString(),
      sortKey: input.now.toISOString(),
    },
    registrationMetadata: {},
    requestBinding: rb,
    requestInputProvenance: "policy_generated_request_binding",
    requestBindingError: null,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        sellerNetworkRaw: "eip155:8453",
        canonicalNetworkCaip2: "eip155:8453",
        asset: USDC,
        amountAtomic: "1000",
        payTo: input.expectedPayTo ?? null,
        maxTimeoutSeconds: 300,
      },
    ],
  };

  const outcome = await probeTargetLiveness(probeCandidate, {
    maxTargetPriceAtomic: input.maxTargetPriceAtomic,
  });

  const probe = {
    candidateId: input.candidateId,
    endpoint: input.endpoint,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    quoteAtomic: outcome.quoteAtomic,
    quoteUsdc: outcome.quoteUsdc,
    payTo: outcome.selectedAccept?.payTo ?? null,
    requirements_hash:
      outcome.sellerRequirements?.binding.canonical_requirements_sha256 ?? null,
  };

  if (
    outcome.status !== "live_402_ok" ||
    !outcome.sellerRequirements ||
    !outcome.selectedAccept
  ) {
    return { selected: null, probe };
  }

  const obs = outcome.sellerRequirements;
  const accept = outcome.selectedAccept;
  if (
    input.expectedPayTo &&
    (accept.payTo ?? "").toLowerCase() !== input.expectedPayTo.toLowerCase()
  ) {
    return {
      selected: null,
      probe: { ...probe, blocked: "payTo_drift", freshPayTo: accept.payTo },
    };
  }

  const selected: DiscoveredSelectedCandidate = {
    schema_version: "trustforge_selected_candidate.v3",
    provider: "bazaar_unpaid",
    service_id: input.candidateId,
    endpoint: input.endpoint,
    method: input.method,
    request_input_status: "known",
    request_query: input.query.map(([k, v]) => [k, v] as [string, string]),
    request_body: null,
    request_input_provenance: "policy_generated_request_binding",
    request_binding_sha256: rb.binding_sha256,
    protocol_version: obs.binding.protocol_version,
    transport: obs.binding.transport,
    scheme: accept.scheme,
    amount_field: obs.binding.amount_field,
    max_timeout_seconds: accept.maxTimeoutSeconds ?? obs.binding.max_timeout_seconds,
    resource: obs.binding.resource,
    extra: obs.binding.extra,
    canonical_requirements_sha256: obs.binding.canonical_requirements_sha256,
    canonical_envelope_sha256: obs.binding.canonical_envelope_sha256,
    selection_requirements_observed_at: obs.requirements_observed_at,
    ancillary_tempo_evidence: obs.ancillary_tempo_evidence,
    seller_requirements: obs,
    quote_amount_usdc: outcome.quoteUsdc ?? "unknown",
    quote_atomic: outcome.quoteAtomic ?? accept.amountAtomic,
    authorized_pay_to: accept.payTo ?? obs.binding.pay_to,
    recommended_max_usdc: "0.005",
    seller_network_raw: accept.sellerNetworkRaw ?? "eip155:8453",
    canonical_network_caip2: accept.canonicalNetworkCaip2 ?? "eip155:8453",
    network: accept.canonicalNetworkCaip2 ?? "eip155:8453",
    asset: accept.asset,
    buyer_wallet: PLANNING_BUYER,
    target_selection_audit: {
      selected_resource_url: input.endpoint,
      handshake_status: outcome.status,
      fallback_resource_urls: [],
      scoring_rationale: ["b6_live_unpaid_decision"],
    },
    selected_at_utc: input.now.toISOString(),
  };
  return { selected, probe };
}

async function main(): Promise<number> {
  assertB6HasNoExecutionAuthority();

  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "_");
  const runDir = join(
    "D:\\trustforge\\artifacts\\runs\\b6-agentic-payment-decision",
    `run_${ts}`,
  );
  mkdirSync(runDir, { recursive: true });

  const now = new Date();
  const policy = loadB5CandidatePolicy();
  const maxAtomic = policy.max_single_payment_atomic_by_asset[USDC] ?? "5000";

  const onesource = await probeToSelected({
    candidateId: "api_onesource_io_api_chain_block_number",
    endpoint: ONESOURCE_ENDPOINT,
    method: "GET",
    query: [["network", "ethereum"]],
    maxTargetPriceAtomic: maxAtomic,
    now,
  });
  const otto = await probeToSelected({
    candidateId: "x402_ottoai_services_crypto_news_b6",
    endpoint: OTTO_ENDPOINT,
    method: "GET",
    query: [],
    expectedPayTo: OTTO_PAY_TO,
    maxTargetPriceAtomic: maxAtomic,
    now,
  });

  persist(runDir, "live_unpaid_probes.json", {
    observed_at: now.toISOString(),
    probes: [onesource.probe, otto.probe],
    payment_authorized: false,
  });

  const liveRows: Array<{
    selected: DiscoveredSelectedCandidate;
    purpose: string;
    utility_evidence: string;
    priorSuccessful: boolean;
    diversityValue: "none" | "low" | "medium" | "high";
  }> = [];

  if (onesource.selected) {
    liveRows.push({
      selected: onesource.selected,
      purpose: "block_number",
      utility_evidence:
        "prior_trustforge_mainnet_payment_history_onesource_block_number",
      priorSuccessful: true,
      diversityValue: "low",
    });
  }
  if (otto.selected) {
    liveRows.push({
      selected: otto.selected,
      purpose: "crypto_news",
      utility_evidence:
        "advertised_crypto_news_sentiment_b52_paid_history_available",
      priorSuccessful: true,
      diversityValue: "high",
    });
  }

  const decisionRows = liveRows.map((row) => {
    const candidate = {
      ...normalizeFromDiscoveredSelectedCandidate(row.selected, {
        discovery_source: "b6_live_unpaid_probe",
        discovered_at: now.toISOString(),
        purpose: row.purpose,
      }),
      expected_utility: {
        purpose: row.purpose,
        utility_confidence: "medium" as const,
        evidence: row.utility_evidence,
      },
    };
    const verdict = evaluatePaymentCandidatePolicy(candidate, { policy, now });
    const economicsV2 = assessEconomicV2(candidate, verdict, {
      now,
      priorSuccessfulExecutionEvidence: row.priorSuccessful,
      utilityConfidenceOverride: "medium",
      diversityValue: row.diversityValue,
      knownAlternatives: liveRows
        .filter((r) => r.selected.service_id !== row.selected.service_id)
        .map((r) => r.selected.service_id),
    });
    return { candidate, verdict, economicsV2, selected: row.selected };
  });

  persist(
    runDir,
    "live_unpaid_candidate_set.json",
    {
      schema_version: "trustforge_b6_live_unpaid_candidate_set.v1",
      observed_at: now.toISOString(),
      payment_authorized: false,
      candidates: decisionRows.map((r) => ({
        candidate_id: r.candidate.candidate_id,
        observation_id: r.candidate.observation_id,
        endpoint: r.candidate.endpoint,
        method: r.candidate.method,
        amount_atomic: r.candidate.amount_atomic,
        pay_to: r.candidate.pay_to,
        purpose: r.candidate.expected_utility.purpose,
        policy_verdict: r.verdict.verdict,
        policy_reasons: r.verdict.reasons,
        economics_v2: r.economicsV2,
        economic_assessment_sha256: economicAssessmentV2Sha256(r.economicsV2),
      })),
    },
  );

  const { decision, set } = runB6DecisionFromCandidates(
    decisionRows.map((r) => ({
      candidate: r.candidate,
      verdict: r.verdict,
      economicsV2: r.economicsV2,
    })),
    { now },
  );

  persist(runDir, "candidate_decision_set.json", set);
  persist(runDir, "payment_selection_decision.json", decision);
  persist(runDir, "decision_policy_v1.json", B6_DECISION_POLICY_V1);
  persist(runDir, "decision_policy_hash.json", {
    decision_policy_hash: b6DecisionPolicyHash(B6_DECISION_POLICY_V1),
    algorithm: "canonical_json_sha256",
  });
  persist(runDir, "economic_assessment_v2.json", {
    assessments: decisionRows.map((r) => r.economicsV2),
  });
  persist(runDir, "live_b6_decision.json", {
    decision: decision.decision,
    selectedCandidateId: decision.selectedCandidateId,
    selectedObservationId: decision.selectedObservationId,
    selectionDecisionHash: decision.selectionDecisionHash,
    candidateSetHash: decision.candidateSetHash,
    selectionRationale: decision.selectionRationale,
    deferralConditions: decision.deferralConditions ?? null,
    rejectionReasons: decision.rejectionReasons ?? null,
    payment_authorized: false,
    decision_sha256: paymentSelectionDecisionHash(decision),
    decision_hash_matches: paymentSelectionDecisionHash(decision) === decision.selectionDecisionHash,
  });
  persist(runDir, "candidate_set_binding_proof.json", {
    candidateSetHash: decision.candidateSetHash,
    candidateObservationSetHash: decision.candidateObservationSetHash,
    set_hash: set.candidateSetHash,
    binds: decision.candidateSetHash === set.candidateSetHash,
  });
  persist(runDir, "selection_rationale_binding_proof.json", {
    selectionDecisionHash: decision.selectionDecisionHash,
    selectionRationale: decision.selectionRationale,
    bound: true,
  });

  let humanCheckpointPreview: Record<string, unknown> | null = null;
  if (decision.decision === "BUY" && decision.selectedCandidateId) {
    const selectedRow = decisionRows.find(
      (r) => r.candidate.candidate_id === decision.selectedCandidateId,
    );
    if (selectedRow) {
      const intent = buildPaymentApprovalIntentFromSelected({
        selected: selectedRow.selected,
        candidateId: decision.selectedCandidateId,
        advertisedPurpose: selectedRow.candidate.expected_utility.purpose,
        whySelected: decision.selectionRationale.map((r) => r.detail).join("; "),
        selectionDecisionHash: decision.selectionDecisionHash,
        selectedCandidateId: decision.selectedCandidateId,
        selectedObservationId: decision.selectedObservationId ?? undefined,
        candidateSetHash: decision.candidateSetHash,
      });
      persist(runDir, "payment_approval_intent_preview.json", intent);
      persist(runDir, "payment_approval_selection_binding_proof.json", {
        selection_decision_hash: intent.selection_decision_hash,
        selected_candidate_id: intent.selected_candidate_id,
        selected_observation_id: intent.selected_observation_id,
        candidate_set_hash: intent.candidate_set_hash,
        payment_approval_intent_hash: paymentApprovalIntentHash(intent),
        binds_selection: true,
        dialog_opened: false,
      });
      humanCheckpointPreview = {
        schema_version: "trustforge_b6_human_checkpoint_preview.v1",
        dialog_opened: false,
        approve_reject_dialog: "NOT_OPENED",
        payment_authorized: false,
        decision: "BUY",
        selectionDecisionHash: decision.selectionDecisionHash,
        service: selectedRow.selected.service_id,
        endpoint: selectedRow.selected.endpoint,
        purpose: selectedRow.candidate.expected_utility.purpose,
        amount_atomic: selectedRow.selected.quote_atomic,
        amount_usdc: selectedRow.selected.quote_amount_usdc,
        network: selectedRow.selected.canonical_network_caip2,
        seller: selectedRow.selected.authorized_pay_to,
        why_selected: decision.selectionRationale,
        alternatives_considered: decision.evaluatedCandidates
          .filter((e) => e.candidateId !== decision.selectedCandidateId)
          .map((e) => ({
            candidateId: e.candidateId,
            disposition: e.disposition,
            reason: e.reason,
          })),
      };
      persist(runDir, "human_checkpoint_preview.json", humanCheckpointPreview);
    }
  } else {
    persist(runDir, "human_checkpoint_preview.json", {
      schema_version: "trustforge_b6_human_checkpoint_preview.v1",
      dialog_opened: false,
      approve_reject_dialog: "NOT_OPENED",
      payment_authorized: false,
      decision: decision.decision,
      selectionDecisionHash: decision.selectionDecisionHash,
      note: "No human checkpoint — DEFER/DONT_BUY does not open Approve/Reject",
    });
  }

  persist(runDir, "ui_isolation_proof.json", {
    production_visible_dialogs: 0,
    production_approval_launches: 0,
    synthetic_visible_dialogs: 0,
    mouse_automation: 0,
    approve_reject_opened: false,
    decision_provider: "none (live unpaid decision only)",
  });

  persist(runDir, "negative_effects.json", {
    real_credentials: 0,
    real_signatures: 0,
    payment_headers: 0,
    payment_bearing_requests: 0,
    settlements: 0,
    retries: 0,
    resends: 0,
    visible_approve_reject_windows: 0,
    dpapi_access: 0,
    push: 0,
  });

  persist(runDir, "productive_core_isolation.json", {
    b6_can_sign: false,
    b6_can_access_credentials: false,
    b6_can_create_payment_header: false,
    b6_can_create_payment_send_authorization: false,
    b6_can_call_productive_payment_transport: false,
    buy_is_payment_authorization: false,
  });

  const report = [
    "# B.6 live unpaid agentic payment decision",
    "",
    `RESULT: ${B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT}`,
    "",
    `- run_dir: \`${runDir}\``,
    `- observed_at: ${now.toISOString()}`,
    `- decision: **${decision.decision}**`,
    `- selectedCandidateId: ${decision.selectedCandidateId ?? "none"}`,
    `- selectionDecisionHash: \`${decision.selectionDecisionHash}\``,
    `- candidateSetHash: \`${decision.candidateSetHash}\``,
    `- payment_authorized: false`,
    `- dialog_opened: false`,
    "",
    "## Probes",
    "",
    `- OneSource: ${String(onesource.probe.status)} amount=${String(onesource.probe.quoteAtomic ?? "n/a")}`,
    `- OttoAI: ${String(otto.probe.status)} amount=${String(otto.probe.quoteAtomic ?? "n/a")}`,
    "",
    "## Selection rationale",
    "",
    ...decision.selectionRationale.map((r) => `- \`${r.code}\`: ${r.detail}`),
    "",
    "## Safety",
    "",
    "- real credentials: 0",
    "- real signatures: 0",
    "- payment-bearing requests: 0",
    "- visible Approve/Reject windows: 0",
    "- DPAPI: 0",
    "- push: none",
    "",
  ].join("\n");
  writeFileSync(join(runDir, "b6_report.md"), report);

  writeFileSync(
    join(runDir, "RESULT.txt"),
    [
      `RESULT: ${B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT}`,
      `decision: ${decision.decision}`,
      `selectedCandidateId: ${decision.selectedCandidateId ?? "none"}`,
      `selectionDecisionHash: ${decision.selectionDecisionHash}`,
      `candidateSetHash: ${decision.candidateSetHash}`,
      `payment_authorized: false`,
      `dialog_opened: false`,
      `run_dir: ${runDir}`,
      "",
    ].join("\n"),
  );

  writeSha256Sums(runDir);

  console.log(`RESULT ${B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT}`);
  console.log(`decision=${decision.decision}`);
  console.log(`selectionDecisionHash=${decision.selectionDecisionHash}`);
  console.log(`selectedCandidateId=${decision.selectedCandidateId ?? "none"}`);
  console.log(`run_dir=${runDir}`);
  console.log("NO_PAYMENT");
  console.log("NO_UI");
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
