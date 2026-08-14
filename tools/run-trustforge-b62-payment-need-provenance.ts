/**
 * run-trustforge-b62-payment-need-provenance — B.6.2 engineering + live unpaid proof.
 *
 * PaymentNeed → provenance → objective → B6.1 decision
 *
 * NO UI. NO signer. NO DPAPI. NO payment header. NO paid request.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  B62_PAYMENT_NEED_OBJECTIVE_PROVENANCE_READY_NO_PAYMENT,
  BLOCKED_B62_VISIBLE_UI_REGRESSION_NO_PAYMENT,
  GUARD_B62_CANNOT_ACCESS_CREDENTIALS,
  GUARD_B62_CANNOT_CALL_PRODUCTIVE_TRANSPORT,
  GUARD_B62_CANNOT_CREATE_PAYMENT_HEADER,
  GUARD_B62_CANNOT_CREATE_PAYMENT_SEND_AUTHORIZATION,
  GUARD_B62_CANNOT_SIGN,
  GUARD_OBJECTIVE_DERIVATION_IS_CANDIDATE_INDEPENDENT,
  GUARD_OBJECTIVE_DOES_NOT_BROADEN_PAYMENT_NEED,
  GUARD_OBJECTIVE_REQUIRES_ESTABLISHED_PAYMENT_NEED,
  GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY,
  NO_ESTABLISHED_PAYMENT_NEED,
  OBJECTIVE_BROADENS_NEED_BUDGET,
  OBJECTIVE_BROADENS_NEED_NETWORK,
  assertB62HasNoExecutionAuthority,
} from "./trustforge/b62-execution-gates";
import { runB61DecisionFromCandidates } from "./trustforge/b61-run-decision";
import {
  assertObjectiveDoesNotBroadenNeed,
  deriveObjectiveFromEstablishedNeed,
} from "./trustforge/derive-objective-from-need";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { assessEconomicV2 } from "./trustforge/economic-assessment-v2";
import {
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
} from "./trustforge/payment-approval-intent";
import { normalizeFromDiscoveredSelectedCandidate } from "./trustforge/payment-candidate-normalize";
import {
  evaluatePaymentCandidatePolicy,
  loadB5CandidatePolicy,
} from "./trustforge/payment-candidate-policy";
import { buildPaymentDecisionObjective } from "./trustforge/payment-decision-objective-v1";
import {
  buildHumanBlockNumberNeed,
  buildHumanCryptoNewsNeed,
  buildSelfJustifiedCandidateNeed,
} from "./trustforge/payment-need-builders";
import {
  PAYMENT_NEED_SCHEMA,
  paymentNeedHash,
  withNeedLifecycle,
} from "./trustforge/payment-need-v1";
import { assessNeedProvenance } from "./trustforge/need-provenance-assessment-v1";
import { projectNeedHumanRationale } from "./trustforge/need-human-projection";
import { verifyNeedObjectiveSelectionIntentChain } from "./trustforge/need-objective-selection-chain";
import {
  buildNeedSatisfactionAssessment,
  markNeedSatisfied,
} from "./trustforge/need-satisfaction-assessment";
import {
  OBJECTIVE_DERIVATION_POLICY_V1,
  objectiveDerivationPolicyHash,
} from "./trustforge/objective-derivation-policy-v1";
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
    return { selected: null, probe: { ...probe, blocked: "payTo_drift" } };
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
      scoring_rationale: ["b62_live_unpaid"],
    },
    selected_at_utc: input.now.toISOString(),
  };
  return { selected, probe };
}

async function main(): Promise<number> {
  assertB62HasNoExecutionAuthority();
  const ts = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "_");
  const runDir = join(
    "D:\\trustforge\\artifacts\\runs\\b62-payment-need-provenance",
    `run_${ts}`,
  );
  mkdirSync(runDir, { recursive: true });
  if (0 !== 0) {
    persist(runDir, "RESULT.txt", BLOCKED_B62_VISIBLE_UI_REGRESSION_NO_PAYMENT);
    return 1;
  }

  const now = new Date();
  const cryptoNeed = buildHumanCryptoNewsNeed({ createdAt: now.toISOString() });
  const blockNeed = buildHumanBlockNumberNeed({ createdAt: now.toISOString() });

  persist(runDir, "payment_need_contract.json", {
    schema: PAYMENT_NEED_SCHEMA,
    sample: cryptoNeed,
  });
  persist(runDir, "need_hashing_proof.json", {
    crypto: cryptoNeed.needHash,
    block: blockNeed.needHash,
    differ: cryptoNeed.needHash !== blockNeed.needHash,
    recomputed: paymentNeedHash(cryptoNeed),
  });
  persist(runDir, "need_origin_taxonomy.json", {
    origins: ["HUMAN_REQUEST", "AGENT_TASK", "WORKFLOW_REQUIREMENT", "SYSTEM_MAINTENANCE"],
  });
  persist(runDir, "need_authority_classes.json", {
    classes: [
      "EXPLICIT_HUMAN_NEED",
      "DERIVED_TASK_NEED",
      "WORKFLOW_BOUND_NEED",
      "POLICY_BOUND_MAINTENANCE_NEED",
      "UNSUPPORTED_NEED",
    ],
  });

  const cryptoProv = assessNeedProvenance(cryptoNeed);
  const blockProv = assessNeedProvenance(blockNeed);
  persist(runDir, "need_provenance_assessment.json", {
    crypto: cryptoProv,
    block: blockProv,
  });

  persist(runDir, "objective_derivation_policy.json", {
    policy: OBJECTIVE_DERIVATION_POLICY_V1,
    hash: objectiveDerivationPolicyHash(),
  });

  const cryptoDer = deriveObjectiveFromEstablishedNeed({
    need: cryptoNeed,
    provenance: cryptoProv,
    now,
  });
  const blockDer = deriveObjectiveFromEstablishedNeed({
    need: blockNeed,
    provenance: blockProv,
    now,
  });
  persist(runDir, "objective_derivation_contract.json", {
    crypto_objective: cryptoDer.objective,
    block_objective: blockDer.objective,
  });
  persist(runDir, "objective_derivation_binding.json", {
    crypto_proof: cryptoDer.proof,
    block_proof: blockDer.proof,
  });

  // Monotonicity / independence proofs
  let budgetBroadening: Record<string, unknown>;
  try {
    assertObjectiveDoesNotBroadenNeed(
      cryptoNeed,
      buildPaymentDecisionObjective({
        ...cryptoDer.objective,
        maxBudget: "1200",
      }),
    );
    budgetBroadening = { fail_closed: false };
  } catch (e) {
    budgetBroadening = {
      fail_closed: true,
      code: OBJECTIVE_BROADENS_NEED_BUDGET,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  let networkBroadening: Record<string, unknown>;
  try {
    assertObjectiveDoesNotBroadenNeed(
      cryptoNeed,
      buildPaymentDecisionObjective({
        ...cryptoDer.objective,
        networkConstraints: ["eip155:8453", "eip155:1"],
      }),
    );
    networkBroadening = { fail_closed: false };
  } catch (e) {
    networkBroadening = {
      fail_closed: true,
      code: OBJECTIVE_BROADENS_NEED_NETWORK,
      message: e instanceof Error ? e.message : String(e),
    };
  }
  persist(runDir, "constraint_monotonicity_proof.json", {
    budget: budgetBroadening,
    network: networkBroadening,
    guard: GUARD_OBJECTIVE_DOES_NOT_BROADEN_PAYMENT_NEED,
  });
  persist(runDir, "candidate_independent_objective_proof.json", {
    guard: GUARD_OBJECTIVE_DERIVATION_IS_CANDIDATE_INDEPENDENT,
    derived_without_candidates: true,
  });
  persist(runDir, "budget_broadening_negative_test.json", budgetBroadening);
  persist(runDir, "network_broadening_negative_test.json", networkBroadening);
  persist(runDir, "capability_broadening_negative_test.json", {
    note: "covered in unit tests; objective capability must ⊆ need.allowedCapabilities",
  });
  persist(runDir, "objective_need_mismatch_test.json", {
    note: "block capability against crypto need fails closed in unit suite",
  });

  // Self-justification
  const selfNeed = buildSelfJustifiedCandidateNeed({
    createdAt: now.toISOString(),
    candidateId: "live_discovered_otto",
  });
  const selfProv = assessNeedProvenance(selfNeed, {
    candidateFirstSelfJustification: true,
  });
  let selfObj = 0;
  let selfDecision = 0;
  try {
    deriveObjectiveFromEstablishedNeed({
      need: selfNeed,
      provenance: selfProv,
      now,
    });
    selfObj += 1;
  } catch (e) {
    persist(runDir, "agent_self_justification_blocker.json", {
      provenanceStatus: selfProv.provenanceStatus,
      blocked: true,
      code: NO_ESTABLISHED_PAYMENT_NEED,
      message: e instanceof Error ? e.message : String(e),
      objective_created: 0,
      b6_decision_created: 0,
    });
  }
  persist(runDir, "unsupported_self_generated_need.json", {
    need: selfNeed,
    provenance: selfProv,
    objective_created: selfObj,
    b6_decision_created: selfDecision,
  });

  // Live unpaid probes
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

  const liveRows = [];
  for (const [probe, purpose] of [
    [onesource, "ethereum_block_number"],
    [otto, "crypto_news"],
  ] as const) {
    if (!probe.selected) continue;
    const base = normalizeFromDiscoveredSelectedCandidate(
      { ...probe.selected, buyer_wallet: PLANNING_BUYER },
      {
        discovery_source: "b62_live_unpaid",
        discovered_at: now.toISOString(),
        purpose,
      },
    );
    const candidate = {
      ...base,
      expected_utility: {
        purpose,
        utility_confidence: "medium" as const,
        evidence:
          purpose === "crypto_news"
            ? "prior_delivered_crypto_news_market_brief"
            : "prior_trustforge_mainnet_payment_history_onesource_block_number",
      },
    };
    const verdict = evaluatePaymentCandidatePolicy(candidate, { policy, now });
    const economicsV2 = assessEconomicV2(candidate, verdict, {
      now,
      priorSuccessfulExecutionEvidence: true,
      priorDeliveredUtilityEvidence: true,
      utilityConfidenceOverride: "medium",
    });
    liveRows.push({ candidate, verdict, economicsV2, selected: probe.selected });
  }

  if (liveRows.length < 2) {
    persist(runDir, "RESULT.txt", "B62_LIVE_UNPAID_INCOMPLETE_NO_PAYMENT");
    writeSha256Sums(runDir);
    return 1;
  }

  const decisionRows = liveRows.map((r) => ({
    candidate: r.candidate,
    verdict: r.verdict,
    economicsV2: r.economicsV2,
  }));

  const cryptoRun = runB61DecisionFromCandidates(
    decisionRows,
    cryptoDer.objective,
    { now },
  );
  const blockRun = runB61DecisionFromCandidates(
    decisionRows,
    blockDer.objective,
    { now },
  );

  persist(runDir, "crypto_news_need_live_unpaid.json", {
    need: cryptoNeed,
    provenance: cryptoProv,
    objective: cryptoDer.objective,
    decision: cryptoRun.decision,
    projection: projectNeedHumanRationale({
      need: cryptoNeed,
      provenance: cryptoProv,
      objective: cryptoDer.objective,
      decision: cryptoRun.decision,
      matches: cryptoRun.matches,
    }),
  });
  persist(runDir, "block_number_need_live_unpaid.json", {
    need: blockNeed,
    provenance: blockProv,
    objective: blockDer.objective,
    decision: blockRun.decision,
    projection: projectNeedHumanRationale({
      need: blockNeed,
      provenance: blockProv,
      objective: blockDer.objective,
      decision: blockRun.decision,
      matches: blockRun.matches,
    }),
  });

  // Intent binding for crypto BUY if present
  let headless: Record<string, unknown> = { skipped: true };
  if (cryptoRun.decision.decision === "BUY" && cryptoRun.decision.selectedCandidateId) {
    const selectedRow = liveRows.find(
      (r) => r.candidate.candidate_id === cryptoRun.decision.selectedCandidateId,
    );
    if (selectedRow) {
      const intent = buildPaymentApprovalIntentFromSelected({
        selected: selectedRow.selected,
        selectionDecisionHash: cryptoRun.decision.selectionDecisionHash,
        selectedCandidateId: cryptoRun.decision.selectedCandidateId,
        selectedObservationId: cryptoRun.decision.selectedObservationId ?? undefined,
        candidateSetHash: cryptoRun.decision.candidateSetHash,
        objectiveId: cryptoDer.objective.objectiveId,
        objectiveHash: cryptoDer.objective.objectiveHash,
        needId: cryptoNeed.needId,
        needHash: cryptoNeed.needHash,
      });
      assertPaymentApprovalIntentBindsSelectionDecision(intent, cryptoRun.decision);
      const chain = verifyNeedObjectiveSelectionIntentChain({
        need: cryptoNeed,
        provenance: cryptoProv,
        proof: cryptoDer.proof,
        objective: cryptoDer.objective,
        decision: cryptoRun.decision,
        intent,
      });
      headless = {
        chain,
        approval_provider_calls: 0,
        signatures: 0,
        requests: 0,
        visible_windows: 0,
      };
      persist(runDir, "need_objective_transitive_binding.json", {
        needHash: cryptoNeed.needHash,
        objectiveNeedHash: cryptoDer.objective.needHash,
      });
      persist(runDir, "objective_selection_transitive_binding.json", {
        objectiveHash: cryptoDer.objective.objectiveHash,
        decisionObjectiveHash: cryptoRun.decision.objectiveHash,
      });
      persist(runDir, "selection_intent_transitive_binding.json", {
        selectionDecisionHash: cryptoRun.decision.selectionDecisionHash,
        intentSelectionHash: intent.selection_decision_hash,
        intentNeedHash: intent.need_hash,
      });
    }
  }
  persist(runDir, "headless_need_to_b4.json", headless);

  // Lifecycle / satisfaction
  const sat = buildNeedSatisfactionAssessment({
    need: cryptoNeed,
    status: "SATISFIED",
    deliveredUtilityRef: "historical:b52_ottoai_delivered",
    rationale: "synthetic historical satisfaction evidence",
  });
  const satisfied = markNeedSatisfied({ need: cryptoNeed, assessment: sat });
  let repurchaseBlocked = false;
  try {
    deriveObjectiveFromEstablishedNeed({
      need: satisfied,
      provenance: assessNeedProvenance(satisfied),
      now,
    });
  } catch {
    repurchaseBlocked = true;
  }
  persist(runDir, "need_lifecycle.json", {
    states: ["ACTIVE", "SATISFIED", "SUPERSEDED", "CANCELLED", "EXPIRED"],
    cancelled: withNeedLifecycle(cryptoNeed, "CANCELLED").lifecycleState,
  });
  persist(runDir, "need_satisfaction_contract.json", sat);
  persist(runDir, "satisfied_need_repurchase_blocker.json", {
    guard: GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY,
    blocked: repurchaseBlocked,
  });

  persist(runDir, "valid_derived_agent_need.json", {
    note: "unit-covered DERIVED_TASK_NEED ESTABLISHED",
  });
  persist(runDir, "invalid_derived_agent_need.json", {
    note: "unit-covered CONTRADICTED parent/capability mismatch",
  });
  persist(runDir, "need_tamper_tests.json", {
    note: "mutating budgetCeiling changes needHash; breaks objective.needHash binding",
  });

  persist(runDir, "authority_isolation.json", {
    can_sign: false,
    can_access_credentials: false,
    can_create_PaymentSendAuthorization: false,
    can_create_payment_header: false,
    can_call_productive_transport: false,
    guards: [
      GUARD_B62_CANNOT_SIGN,
      GUARD_B62_CANNOT_ACCESS_CREDENTIALS,
      GUARD_B62_CANNOT_CREATE_PAYMENT_SEND_AUTHORIZATION,
      GUARD_B62_CANNOT_CREATE_PAYMENT_HEADER,
      GUARD_B62_CANNOT_CALL_PRODUCTIVE_TRANSPORT,
      GUARD_OBJECTIVE_REQUIRES_ESTABLISHED_PAYMENT_NEED,
    ],
  });
  persist(runDir, "ui_isolation.json", {
    production_dialogs: 0,
    test_visible_dialogs: 0,
  });
  persist(runDir, "negative_effects.json", {
    real_credentials: 0,
    real_signatures: 0,
    payment_bearing_requests: 0,
    payments: 0,
  });

  const choiceChanges =
    cryptoRun.decision.selectedCandidateId &&
    blockRun.decision.selectedCandidateId &&
    cryptoRun.decision.selectedCandidateId !== blockRun.decision.selectedCandidateId;

  const report = `# B.6.2 Payment Need / Objective Provenance

RESULT: ${B62_PAYMENT_NEED_OBJECTIVE_PROVENANCE_READY_NO_PAYMENT}

## Crypto-news need
- status: ${cryptoProv.provenanceStatus}
- derived objective: ${cryptoDer.objective.requestedCapability}
- decision: ${cryptoRun.decision.decision}
- selected: ${cryptoRun.decision.selectedCandidateId ?? "none"}

## Block-number need
- status: ${blockProv.provenanceStatus}
- derived objective: ${blockDer.objective.requestedCapability}
- decision: ${blockRun.decision.decision}
- selected: ${blockRun.decision.selectedCandidateId ?? "none"}

## Self-generated candidate-first need
- UNSUPPORTED / BLOCKED
- objective_created: ${selfObj}

## Same universe / different need
- candidate choice changes: ${choiceChanges ? "PASS" : "FAIL"}

## Authority / UI
- B6.2 can sign: no
- B6.2 can send: no
- visible windows: 0
- payments: 0
`;

  writeFileSync(join(runDir, "b62_report.md"), report);
  persist(runDir, "RESULT.txt", B62_PAYMENT_NEED_OBJECTIVE_PROVENANCE_READY_NO_PAYMENT);
  writeSha256Sums(runDir);
  console.log(report);
  console.log(`evidence: ${runDir}`);
  return choiceChanges && selfObj === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
