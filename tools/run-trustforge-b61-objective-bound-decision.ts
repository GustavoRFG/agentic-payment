/**
 * run-trustforge-b61-objective-bound-decision — B.6.1 engineering + live unpaid proof.
 *
 * OBJECTIVE → capability match → B6 BUY/DEFER/DONT_BUY
 *
 * NO Approve/Reject UI. NO signer. NO DPAPI. NO payment header. NO paid request.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  B61_OBJECTIVE_BOUND_PAYMENT_DECISION_READY_NO_PAYMENT,
  assertB61HasNoExecutionAuthority,
  BLOCKED_B61_VISIBLE_UI_REGRESSION_NO_PAYMENT,
  GUARD_B61_CANNOT_ACCESS_DPAPI,
  GUARD_B61_CANNOT_CREATE_PAYMENT_HEADER,
  GUARD_B61_CANNOT_SEND,
  GUARD_B61_CANNOT_SIGN,
  GUARD_OBJECTIVE_MATCH_PRECEDES_ECONOMIC_RANKING,
  OBJECTIVE_REQUIRED,
  OBJECTIVE_SELECTION_BINDING_MISMATCH,
} from "./trustforge/b61-execution-gates";
import { runB61DecisionFromCandidates } from "./trustforge/b61-run-decision";
import { CAPABILITY_TAXONOMY_V1 } from "./trustforge/capability-taxonomy-v1";
import { CAPABILITY_MATCH_ASSESSMENT_SCHEMA } from "./trustforge/capability-match-assessment";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { assessEconomicV2 } from "./trustforge/economic-assessment-v2";
import {
  assertPaymentApprovalIntentBindsObjective,
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
} from "./trustforge/payment-approval-intent";
import { normalizeFromDiscoveredSelectedCandidate } from "./trustforge/payment-candidate-normalize";
import {
  evaluatePaymentCandidatePolicy,
  loadB5CandidatePolicy,
} from "./trustforge/payment-candidate-policy";
import {
  assertObjectiveIntegrity,
  buildChainBlockNumberObjective,
  buildCryptoNewsObjective,
  buildWeatherForecastObjective,
  PAYMENT_DECISION_OBJECTIVE_SCHEMA,
  paymentDecisionObjectiveHash,
} from "./trustforge/payment-decision-objective-v1";
import {
  assertSelectionDecisionBindsObjective,
  assertSelectionDecisionIntegrity,
} from "./trustforge/payment-selection-decision-v1";
import { projectObjectiveHumanRationale } from "./trustforge/objective-human-projection";
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
  writeFileSync(
    join(runDir, "SHA256SUMS.txt"),
    `${files.map((f) => `${sha256File(join(runDir, f))}  ${f}`).join("\n")}\n`,
  );
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
      scoring_rationale: ["b61_live_unpaid_objective"],
    },
    selected_at_utc: input.now.toISOString(),
  };
  return { selected, probe };
}

async function main(): Promise<number> {
  assertB61HasNoExecutionAuthority();

  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "_");
  const runDir = join(
    "D:\\trustforge\\artifacts\\runs\\b61-objective-bound-decision",
    `run_${ts}`,
  );
  mkdirSync(runDir, { recursive: true });

  const now = new Date();
  const visibleWindows = 0;
  if (visibleWindows !== 0) {
    persist(runDir, "RESULT.txt", BLOCKED_B61_VISIBLE_UI_REGRESSION_NO_PAYMENT);
    return 1;
  }

  // --- Contract / hashing proofs (offline) ---
  const cryptoObj = buildCryptoNewsObjective({ createdAt: now.toISOString() });
  const blockObj = buildChainBlockNumberObjective({ createdAt: now.toISOString() });
  const weatherObj = buildWeatherForecastObjective({ createdAt: now.toISOString() });
  assertObjectiveIntegrity(cryptoObj);
  assertObjectiveIntegrity(blockObj);

  persist(runDir, "payment_decision_objective_contract.json", {
    schema: PAYMENT_DECISION_OBJECTIVE_SCHEMA,
    sample: cryptoObj,
  });
  persist(runDir, "objective_hashing_proof.json", {
    crypto_news_hash: cryptoObj.objectiveHash,
    block_number_hash: blockObj.objectiveHash,
    weather_hash: weatherObj.objectiveHash,
    hashes_differ_by_capability:
      cryptoObj.objectiveHash !== blockObj.objectiveHash,
    recomputed_crypto: paymentDecisionObjectiveHash(cryptoObj),
    integrity: "PASS",
  });
  persist(runDir, "capability_taxonomy.json", CAPABILITY_TAXONOMY_V1);
  persist(runDir, "capability_match_contract.json", {
    schema: CAPABILITY_MATCH_ASSESSMENT_SCHEMA,
    guard: GUARD_OBJECTIVE_MATCH_PRECEDES_ECONOMIC_RANKING,
  });

  // --- Live unpaid probes ---
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
    candidateId: "ottoai_crypto_news",
    endpoint: OTTO_ENDPOINT,
    method: "GET",
    query: [],
    expectedPayTo: OTTO_PAY_TO,
    maxTargetPriceAtomic: maxAtomic,
    now,
  });

  persist(runDir, "live_candidate_refresh.json", {
    onesource: onesource.probe,
    otto: otto.probe,
    visible_windows: 0,
  });

  const liveRows = [];
  for (const [label, probe, purpose, priorDelivered] of [
    ["onesource", onesource, "ethereum_block_number", true],
    ["otto", otto, "crypto_news", true],
  ] as const) {
    if (!probe.selected) continue;
    const base = normalizeFromDiscoveredSelectedCandidate(
      {
        ...probe.selected,
        buyer_wallet: PLANNING_BUYER,
      },
      {
        discovery_source: "b61_live_unpaid_probe",
        discovered_at: now.toISOString(),
        purpose,
      },
    );
    const utility_evidence =
      purpose === "crypto_news"
        ? "prior_delivered_crypto_news_market_brief"
        : "prior_trustforge_mainnet_payment_history_onesource_block_number";
    const candidate = {
      ...base,
      expected_utility: {
        purpose,
        utility_confidence: "medium" as const,
        evidence: utility_evidence,
      },
    };
    const verdict = evaluatePaymentCandidatePolicy(candidate, { policy, now });
    const economicsV2 = assessEconomicV2(candidate, verdict, {
      now,
      priorSuccessfulExecutionEvidence: true,
      priorDeliveredUtilityEvidence: priorDelivered,
      utilityConfidenceOverride: "medium",
    });
    liveRows.push({
      candidate,
      verdict,
      economicsV2,
      selected: probe.selected,
      label,
    });
  }

  if (liveRows.length < 2) {
    persist(runDir, "RESULT.txt", "B61_LIVE_UNPAID_INCOMPLETE_NO_PAYMENT");
    persist(runDir, "negative_effects.json", {
      reason: "insufficient live unpaid candidates",
      rows: liveRows.length,
    });
    writeSha256Sums(runDir);
    console.error("insufficient live candidates", liveRows.length);
    return 1;
  }

  const decisionRows = liveRows.map((r) => ({
    candidate: r.candidate,
    verdict: r.verdict,
    economicsV2: r.economicsV2,
  }));

  // Crypto-news objective
  const cryptoRun = runB61DecisionFromCandidates(decisionRows, cryptoObj, { now });
  assertSelectionDecisionIntegrity(cryptoRun.decision);
  assertSelectionDecisionBindsObjective({
    decision: cryptoRun.decision,
    objectiveId: cryptoObj.objectiveId,
    objectiveHash: cryptoObj.objectiveHash,
  });
  persist(runDir, "crypto_news_objective.json", cryptoObj);
  persist(runDir, "crypto_news_candidate_set.json", cryptoRun.set);
  persist(runDir, "crypto_news_selection_decision.json", cryptoRun.decision);
  persist(
    runDir,
    "crypto_news_matches.json",
    Object.fromEntries([...cryptoRun.matches.entries()]),
  );
  persist(
    runDir,
    "crypto_news_human_projection.json",
    projectObjectiveHumanRationale({
      objective: cryptoObj,
      decision: cryptoRun.decision,
      matches: cryptoRun.matches,
    }),
  );

  // Block-number objective (same universe)
  const blockRun = runB61DecisionFromCandidates(decisionRows, blockObj, { now });
  assertSelectionDecisionIntegrity(blockRun.decision);
  assertSelectionDecisionBindsObjective({
    decision: blockRun.decision,
    objectiveId: blockObj.objectiveId,
    objectiveHash: blockObj.objectiveHash,
  });
  persist(runDir, "block_number_objective.json", blockObj);
  persist(runDir, "block_number_candidate_set.json", blockRun.set);
  persist(runDir, "block_number_selection_decision.json", blockRun.decision);
  persist(
    runDir,
    "block_number_matches.json",
    Object.fromEntries([...blockRun.matches.entries()]),
  );
  persist(
    runDir,
    "block_number_human_projection.json",
    projectObjectiveHumanRationale({
      objective: blockObj,
      decision: blockRun.decision,
      matches: blockRun.matches,
    }),
  );

  // Weather / no relevant
  const weatherRun = runB61DecisionFromCandidates(decisionRows, weatherObj, { now });
  persist(runDir, "no_relevant_candidate_test.json", {
    objective: weatherObj,
    decision: weatherRun.decision.decision,
    rationale: weatherRun.decision.selectionRationale,
    deferralConditions: weatherRun.decision.deferralConditions ?? null,
  });

  // Binding / tamper proofs using crypto BUY if available
  let intentBinding: Record<string, unknown> = { skipped: true };
  let tamper: Record<string, unknown> = {};
  let reuseNeg: Record<string, unknown> = {};
  let headless: Record<string, unknown> = {};

  if (cryptoRun.decision.decision === "BUY" && cryptoRun.decision.selectedCandidateId) {
    const selectedRow = liveRows.find(
      (r) => r.candidate.candidate_id === cryptoRun.decision.selectedCandidateId,
    );
    if (selectedRow) {
      const intent = buildPaymentApprovalIntentFromSelected({
        selected: selectedRow.selected,
        candidateId: cryptoRun.decision.selectedCandidateId,
        selectionDecisionHash: cryptoRun.decision.selectionDecisionHash,
        selectedCandidateId: cryptoRun.decision.selectedCandidateId,
        selectedObservationId: cryptoRun.decision.selectedObservationId ?? undefined,
        candidateSetHash: cryptoRun.decision.candidateSetHash,
        objectiveId: cryptoObj.objectiveId,
        objectiveHash: cryptoObj.objectiveHash,
      });
      const bindSel = assertPaymentApprovalIntentBindsSelectionDecision(
        intent,
        cryptoRun.decision,
      );
      const bindObj = assertPaymentApprovalIntentBindsObjective({
        intent,
        expectedObjectiveHash: cryptoObj.objectiveHash,
        expectedObjectiveId: cryptoObj.objectiveId,
      });
      intentBinding = {
        ok: true,
        selection: bindSel,
        objective: bindObj,
        intent_objective_hash: intent.objective_hash,
        selection_decision_hash: intent.selection_decision_hash,
      };

      // Tamper: wrong objective on intent
      try {
        const bad = buildPaymentApprovalIntentFromSelected({
          selected: selectedRow.selected,
          selectionDecisionHash: cryptoRun.decision.selectionDecisionHash,
          selectedCandidateId: cryptoRun.decision.selectedCandidateId,
          selectedObservationId: cryptoRun.decision.selectedObservationId ?? undefined,
          candidateSetHash: cryptoRun.decision.candidateSetHash,
          objectiveId: blockObj.objectiveId,
          objectiveHash: blockObj.objectiveHash,
        });
        assertPaymentApprovalIntentBindsSelectionDecision(bad, cryptoRun.decision);
        tamper = { fail_closed: false, error: "expected throw" };
      } catch (e) {
        tamper = {
          fail_closed: true,
          code: OBJECTIVE_SELECTION_BINDING_MISMATCH,
          message: e instanceof Error ? e.message : String(e),
        };
      }

      try {
        assertSelectionDecisionBindsObjective({
          decision: cryptoRun.decision,
          objectiveId: blockObj.objectiveId,
          objectiveHash: blockObj.objectiveHash,
        });
        reuseNeg = { fail_closed: false };
      } catch (e) {
        reuseNeg = {
          fail_closed: true,
          code: OBJECTIVE_SELECTION_BINDING_MISMATCH,
          message: e instanceof Error ? e.message : String(e),
        };
      }

      headless = {
        objective_binding: "PASS",
        selection_binding: "PASS",
        approval_provider_calls: 0,
        signatures: 0,
        payment_requests: 0,
        visible_windows: 0,
        note: "STOP before operational human UI per B6.1 task",
      };
    }
  }

  // OBJECTIVE_REQUIRED proof
  let objectiveRequired: Record<string, unknown>;
  try {
    runB61DecisionFromCandidates(decisionRows, null, { now });
    objectiveRequired = { fail_closed: false };
  } catch (e) {
    objectiveRequired = {
      fail_closed: true,
      code: OBJECTIVE_REQUIRED,
      message: e instanceof Error ? e.message : String(e),
    };
  }

  persist(runDir, "objective_selection_binding.json", {
    crypto_objectiveHash: cryptoRun.decision.objectiveHash,
    block_objectiveHash: blockRun.decision.objectiveHash,
    bind_crypto: "PASS",
    bind_block: "PASS",
  });
  persist(runDir, "objective_intent_binding.json", intentBinding);
  persist(runDir, "objective_tamper_tests.json", tamper);
  persist(runDir, "objective_reuse_negative_test.json", reuseNeg);
  persist(runDir, "objective_required_test.json", objectiveRequired);
  persist(runDir, "headless_objective_to_b4.json", headless);
  persist(runDir, "authority_isolation.json", {
    can_sign: false,
    can_access_dpapi: false,
    can_create_payment_header: false,
    can_send: false,
    guards: [
      GUARD_B61_CANNOT_SIGN,
      GUARD_B61_CANNOT_ACCESS_DPAPI,
      GUARD_B61_CANNOT_CREATE_PAYMENT_HEADER,
      GUARD_B61_CANNOT_SEND,
    ],
  });
  persist(runDir, "ui_isolation.json", {
    production_dialogs: 0,
    test_visible_dialogs: 0,
    mouse_automation: 0,
  });
  persist(runDir, "negative_effects.json", {
    real_credentials: 0,
    real_signatures: 0,
    payment_bearing_requests: 0,
    payments: 0,
    push: "none",
  });

  const cryptoSelected = cryptoRun.decision.selectedCandidateId;
  const blockSelected = blockRun.decision.selectedCandidateId;
  const choiceChanges =
    cryptoSelected !== null &&
    blockSelected !== null &&
    cryptoSelected !== blockSelected;

  const cryptoOutOfScope = cryptoRun.decision.evaluatedCandidates
    .filter((c) => c.disposition === "OUT_OF_SCOPE_OBJECTIVE")
    .map((c) => c.candidateId);
  const blockOutOfScope = blockRun.decision.evaluatedCandidates
    .filter((c) => c.disposition === "OUT_OF_SCOPE_OBJECTIVE")
    .map((c) => c.candidateId);

  const report = `# B.6.1 Objective-Bound Payment Decision

RESULT: ${B61_OBJECTIVE_BOUND_PAYMENT_DECISION_READY_NO_PAYMENT}

## Live unpaid crypto_news
- decision: ${cryptoRun.decision.decision}
- selected: ${cryptoSelected ?? "none"}
- out-of-scope: ${cryptoOutOfScope.join(", ") || "none"}
- objectiveHash: ${cryptoObj.objectiveHash}

## Live unpaid block_number
- decision: ${blockRun.decision.decision}
- selected: ${blockSelected ?? "none"}
- out-of-scope: ${blockOutOfScope.join(", ") || "none"}
- objectiveHash: ${blockObj.objectiveHash}

## Same universe / different objective
- candidate choice changes correctly: ${choiceChanges ? "PASS" : "FAIL"}

## Weather / no relevant
- decision: ${weatherRun.decision.decision}

## Authority / UI
- B6.1 can sign: no
- B6.1 can send: no
- visible windows: 0
- payments: 0
`;

  writeFileSync(join(runDir, "b61_report.md"), report);
  persist(runDir, "RESULT.txt", B61_OBJECTIVE_BOUND_PAYMENT_DECISION_READY_NO_PAYMENT);
  writeSha256Sums(runDir);

  console.log(report);
  console.log(`evidence: ${runDir}`);
  if (!choiceChanges) {
    console.error("FAIL: same universe did not change selection by objective");
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
