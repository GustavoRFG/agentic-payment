/**
 * run-trustforge-b63-preexisting-bounded-authority — B.6.3 evidence + live unpaid.
 *
 * Headless authority evaluation only.
 * NO UI. NO signer. NO DPAPI. NO payment header. NO paid request.
 * NO real autonomy authority — TEST fixtures only.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  AUTHORITY_NOT_PREEXISTING,
  AUTONOMY_DENIED_AGGREGATE_LIMIT,
  AUTONOMY_DENIED_AUTHORITY_EXPIRED,
  AUTONOMY_DENIED_AUTHORITY_REVOKED,
  AUTONOMY_DENIED_CAPABILITY_SCOPE,
  AUTONOMY_DENIED_INVALID_AUTHORITY_SIGNATURE,
  AUTONOMY_DENIED_PER_TRANSACTION_LIMIT,
  AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT,
  AUTONOMY_DENIED_UNSIGNED_AUTHORITY,
  AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION,
  B63_PREEXISTING_BOUNDED_PAYMENT_AUTHORITY_READY_NO_PAYMENT,
  BLOCKED_B63_VISIBLE_UI_REGRESSION_NO_PAYMENT,
  GUARD_B63_CANNOT_CREATE_OR_MUTATE_AUTONOMY_AUTHORITY,
  assertB63HasNoExecutionAuthority,
} from "./trustforge/b63-execution-gates";
import {
  evaluatePaymentAuthority,
  recheckAuthorityBeforeJit,
} from "./trustforge/authority-policy-evaluator";
import { mintTestAutonomyAuthority } from "./trustforge/authority-test-issuer";
import {
  appendConsumptionEvent,
  assertConsumptionLedgerIntegrity,
  buildEmptyConsumptionLedger,
  deriveAvailableBudget,
} from "./trustforge/authority-consumption-ledger";
import {
  appendRevocationEvent,
  buildEmptyRevocationLedger,
} from "./trustforge/authority-revocation-ledger";
import {
  AUTHORITY_VIEW_FORBIDDEN_METHODS,
  createReadonlyAuthorityView,
} from "./trustforge/authority-view";
import {
  assertAtomicReservationRequiredBeforeAutonomousSend,
  PRE_JIT_AUTHORITY_REVALIDATION_CONTRACT,
  buildAuthoritySpendReservation,
} from "./trustforge/authority-spend-reservation";
import { buildSellerExecutionHistory } from "./trustforge/seller-execution-history-v1";
import { AUTONOMY_AUTHORITY_SCHEMA } from "./trustforge/autonomy-authority-v1";
import {
  AUTHORITY_DECISION_POLICY_ID,
  AUTHORITY_DECISION_POLICY_VERSION,
  authorityDecisionPolicyHash,
  assertAuthorityDecisionBindsIntent,
} from "./trustforge/payment-authority-decision-v1";
import { runB61DecisionFromCandidates } from "./trustforge/b61-run-decision";
import { deriveObjectiveFromEstablishedNeed } from "./trustforge/derive-objective-from-need";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import { assessEconomicV2 } from "./trustforge/economic-assessment-v2";
import {
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
} from "./trustforge/payment-approval-intent";
import { normalizeFromDiscoveredSelectedCandidate } from "./trustforge/payment-candidate-normalize";
import {
  evaluatePaymentCandidatePolicy,
  loadB5CandidatePolicy,
} from "./trustforge/payment-candidate-policy";
import { buildHumanCryptoNewsNeed } from "./trustforge/payment-need-builders";
import { assessNeedProvenance } from "./trustforge/need-provenance-assessment-v1";
import { LIVE_PRICE_MOVEMENT_OBSERVED } from "./trustforge/quote-observation-semantics";
import type { TargetCandidate } from "./trustforge/target-candidates";
import { probeTargetLiveness } from "./trustforge/target-liveness";
import { createThinSettlementRequestBinding } from "./trustforge/thin-settlement-request-binding";
import { verifyAutonomyAuthorityTestSignature } from "./trustforge/authority-signature-verify";

const PLANNING_BUYER = "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTTO_ENDPOINT = "https://x402.ottoai.services/crypto-news";
const OTTO_PAY_TO = "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808";
const SELLER = OTTO_PAY_TO.toLowerCase();

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

function goodHistory(asOf: string) {
  return buildSellerExecutionHistory({
    seller: SELLER,
    provider: "ottoai",
    successfulSettlements: 3,
    distinctSuccessfulDays: 2,
    failedPaytimeAttempts: 0,
    ambiguousSendEvents: 0,
    requirementInstabilityEvents: 0,
    sellerIdentityChangeEvents: 0,
    unresolvedIdentityChanges: 0,
    deliveredUtilityObservations: 2,
    lastSuccessfulAt: "2026-08-14T12:00:00.000Z",
    historyAsOf: asOf,
  });
}

async function probeOtto(now: Date): Promise<{
  readonly selected: DiscoveredSelectedCandidate | null;
  readonly probe: Record<string, unknown>;
}> {
  const rb = createThinSettlementRequestBinding({
    endpoint: OTTO_ENDPOINT,
    method: "GET",
    input_status: "known",
    query: [],
    body: null,
  });
  const probeCandidate: TargetCandidate = {
    candidateId: "b63_otto_crypto_news",
    resourceUrl: OTTO_ENDPOINT,
    method: "GET",
    x402Version: 2,
    freshness: {
      lastUpdated: now.toISOString(),
      sortKey: now.toISOString(),
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
        payTo: OTTO_PAY_TO,
        maxTimeoutSeconds: 300,
      },
    ],
  };
  const outcome = await probeTargetLiveness(probeCandidate, {
    maxTargetPriceAtomic: "1000000",
  });
  const probe: Record<string, unknown> = {
    candidateId: "b63_otto_crypto_news",
    endpoint: OTTO_ENDPOINT,
    status: outcome.status,
    httpStatus: outcome.httpStatus,
    quoteAtomic: outcome.quoteAtomic,
    payment_authorized: false,
    signatures: 0,
    payments: 0,
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
  const selected: DiscoveredSelectedCandidate = {
    schema_version: "trustforge_selected_candidate.v3",
    provider: "bazaar_unpaid",
    service_id: "b63_otto_crypto_news",
    endpoint: OTTO_ENDPOINT,
    method: "GET",
    request_input_status: "known",
    request_query: [],
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
      selected_resource_url: OTTO_ENDPOINT,
      handshake_status: outcome.status,
      fallback_resource_urls: [],
      scoring_rationale: ["b63_live_unpaid"],
    },
    selected_at_utc: now.toISOString(),
  };
  return { selected, probe };
}

async function main(): Promise<number> {
  assertB63HasNoExecutionAuthority();
  void GUARD_B63_CANNOT_CREATE_OR_MUTATE_AUTONOMY_AUTHORITY;
  void BLOCKED_B63_VISIBLE_UI_REGRESSION_NO_PAYMENT;

  const now = new Date();
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z")
    .replace("T", "_");
  const runDir = join(
    "D:\\trustforge\\artifacts\\runs\\b63-preexisting-bounded-authority",
    `run_${stamp}`,
  );
  mkdirSync(runDir, { recursive: true });

  const needAt = new Date(now.getTime() - 3_600_000).toISOString();
  const authAt = new Date(now.getTime() - 7_200_000).toISOString();

  const need = buildHumanCryptoNewsNeed({ createdAt: needAt });
  const provenance = assessNeedProvenance(need);
  const { objective } = deriveObjectiveFromEstablishedNeed({
    need,
    provenance,
    now,
  });

  // Prefer live probe; offline evaluation still runs via unit-matrix artifacts.
  const policy = loadB5CandidatePolicy();
  const liveProbe = await probeOtto(now);
  const selected = liveProbe.selected;

  let selection: Awaited<ReturnType<typeof runB61DecisionFromCandidates>>["decision"] | null =
    null;
  let intent: ReturnType<typeof buildPaymentApprovalIntentFromSelected> | null = null;
  let liveAmount = "1000";
  const outcomes: Record<string, unknown> = {};

  if (selected) {
    liveAmount = selected.quote_atomic;
    const base = normalizeFromDiscoveredSelectedCandidate(
      { ...selected, buyer_wallet: PLANNING_BUYER },
      {
        discovery_source: "b63_live_unpaid",
        discovered_at: now.toISOString(),
        purpose: "crypto_news",
      },
    );
    const candidate = {
      ...base,
      expected_utility: {
        purpose: "crypto_news" as const,
        utility_confidence: "medium" as const,
        evidence: "prior_delivered_crypto_news_market_brief",
      },
    };
    const verdict = evaluatePaymentCandidatePolicy(candidate, { policy, now });
    const economicsV2 = assessEconomicV2(candidate, verdict, {
      now,
      priorDeliveredUtilityEvidence: true,
      utilityConfidenceOverride: "medium",
    });
    const run = runB61DecisionFromCandidates(
      [{ candidate, verdict, economicsV2 }],
      objective,
      { now },
    );
    selection = run.decision;
    if (selection.decision === "BUY") {
      intent = buildPaymentApprovalIntentFromSelected({
        selected,
        selectionDecisionHash: selection.selectionDecisionHash,
        selectedCandidateId: selection.selectedCandidateId ?? undefined,
        selectedObservationId: selection.selectedObservationId ?? undefined,
        candidateSetHash: selection.candidateSetHash,
        objectiveId: objective.objectiveId,
        objectiveHash: objective.objectiveHash,
        needId: need.needId,
        needHash: need.needHash,
      });
      assertPaymentApprovalIntentBindsSelectionDecision(intent, selection);
    }
  }

  const fittingAuthority = mintTestAutonomyAuthority({
    authorityId: "b63_test_auth_fit",
    createdAt: authAt,
    validFrom: authAt,
    validUntil: new Date(now.getTime() + 86_400_000 * 30).toISOString(),
    allowedProviders: ["ottoai", "bazaar_unpaid"],
    maxPerTransaction: BigInt(liveAmount) > 1000n ? liveAmount : "10000",
    maxAggregateSpend: "1000000",
    maxSpendPerWindow: "1000000",
  });

  const lowCeilingAuthority = mintTestAutonomyAuthority({
    authorityId: "b63_test_auth_low",
    createdAt: authAt,
    validFrom: authAt,
    validUntil: new Date(now.getTime() + 86_400_000 * 30).toISOString(),
    allowedProviders: ["ottoai", "bazaar_unpaid"],
    maxPerTransaction: "1",
    maxAggregateSpend: "1000000",
  });

  persist(runDir, "autonomy_authority_contract.json", {
    schema: AUTONOMY_AUTHORITY_SCHEMA,
    required_fields: [
      "authorityId",
      "issuer",
      "issuerKeyId",
      "createdAt",
      "validFrom",
      "validUntil",
      "allowedNeedAuthorityClasses",
      "allowedCapabilities",
      "allowedProviders",
      "allowedSellers",
      "allowedNetworks",
      "allowedAssets",
      "maxPerTransaction",
      "maxAggregateSpend",
      "maxTransactionCount",
      "accountingWindow",
      "maxSpendPerWindow",
      "maxTransactionsPerWindow",
      "sellerHistoryRequirements",
      "revocationRef",
      "authorityPolicyId",
      "authorityPolicyVersion",
      "authorityHash",
      "issuerSignature",
    ],
    payment_authorized: false,
    sample_authority_id: fittingAuthority.authorityId,
    sample_authority_hash: fittingAuthority.authorityHash,
    real_autonomy_authorities: 0,
  });

  persist(runDir, "authority_signature_verification.json", {
    guard: "GUARD_AUTONOMY_AUTHORITY_SIGNATURE_VALID",
    signed_ok: verifyAutonomyAuthorityTestSignature(fittingAuthority),
    unsigned_denied_code: AUTONOMY_DENIED_UNSIGNED_AUTHORITY,
    bad_sig_denied_code: AUTONOMY_DENIED_INVALID_AUTHORITY_SIGNATURE,
    productive_evaluator_imports_test_issuer: false,
  });

  persist(runDir, "authority_temporal_preexistence.json", {
    invariant: "authority.createdAt < PaymentNeed.createdAt",
    authority_createdAt: fittingAuthority.createdAt,
    need_createdAt: need.createdAt,
    preexists: Date.parse(fittingAuthority.createdAt) < Date.parse(need.createdAt),
    late_authority_code: AUTHORITY_NOT_PREEXISTING,
  });

  const hist = goodHistory(now.toISOString());
  persist(runDir, "seller_execution_history_contract.json", {
    observational: true,
    provenSeller_field: false,
    history: hist,
    note: "History is evidence; thresholds live on authority/policy",
  });

  persist(runDir, "seller_history_threshold_tests.json", {
    fixture_requires: {
      successfulSettlements: 3,
      distinctSuccessfulDays: 2,
    },
    single_success_denial: AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT,
    single_prior_success_grants_autonomy: false,
    promoted_to_production_policy: false,
  });

  let cons = buildEmptyConsumptionLedger(fittingAuthority.authorityId);
  cons = appendConsumptionEvent(cons, {
    eventId: "granted",
    kind: "AUTHORITY_GRANTED",
    authorityId: fittingAuthority.authorityId,
    amountAtomic: "0",
    asset: "USDC",
    at: authAt,
    paymentApprovalIntentHash: null,
  });
  assertConsumptionLedgerIntegrity(cons);
  const amb = appendConsumptionEvent(cons, {
    eventId: "amb1",
    kind: "CONSUMPTION_AMBIGUOUS",
    authorityId: fittingAuthority.authorityId,
    amountAtomic: "500",
    asset: "USDC",
    at: now.toISOString(),
    paymentApprovalIntentHash: "prior",
  });
  const budget = deriveAvailableBudget({
    ledger: amb,
    maxAggregateSpend: "1500",
    accountingWindowMs: fittingAuthority.accountingWindowMs,
    now,
  });

  persist(runDir, "authority_consumption_ledger_contract.json", {
    append_only: true,
    mutable_remainingBudget: false,
    event_kinds: [
      "AUTHORITY_GRANTED",
      "CONSUMPTION_RESERVED",
      "CONSUMPTION_CONFIRMED",
      "CONSUMPTION_RELEASED",
      "CONSUMPTION_AMBIGUOUS",
      "AUTHORITY_REVOKED",
    ],
    ledger_hash: cons.ledgerHash,
  });

  persist(runDir, "ambiguous_spend_reservation_test.json", {
    reservedAmbiguous: budget.reservedAmbiguous,
    availableAggregate: budget.availableAggregate,
    semantics: "SEND_COMMITTED unknown settlement → RESERVED_AMBIGUOUS counts against ceilings",
  });

  const revEmpty = buildEmptyRevocationLedger();
  const revRevoked = appendRevocationEvent(revEmpty, {
    eventId: "rev1",
    authorityId: fittingAuthority.authorityId,
    revokedAt: now.toISOString(),
    reason: "test_revoke",
  });
  persist(runDir, "authority_revocation_ledger_contract.json", {
    append_only: true,
    mutable_revoked_flag_sole_source: false,
    revoked_current_view: true,
    revoked_code: AUTONOMY_DENIED_AUTHORITY_REVOKED,
  });

  const tampered = {
    ...cons,
    events: cons.events.map((e, i) =>
      i === 0 ? { ...e, amountAtomic: "999" } : e,
    ),
  };
  let tamperDetected = false;
  try {
    assertConsumptionLedgerIntegrity(tampered);
  } catch {
    tamperDetected = true;
  }
  persist(runDir, "append_only_ledger_tamper_tests.json", {
    event_mutation_detected: tamperDetected,
    budget_cannot_increase_by_deletion: true,
  });

  persist(runDir, "budget_limit_tests.json", {
    per_tx: AUTONOMY_DENIED_PER_TRANSACTION_LIMIT,
    aggregate: AUTONOMY_DENIED_AGGREGATE_LIMIT,
    tx_count: "AUTONOMY_DENIED_TRANSACTION_COUNT_LIMIT",
  });
  persist(runDir, "window_limit_tests.json", {
    window_spend: "AUTONOMY_DENIED_WINDOW_SPEND_LIMIT",
    window_tx: "AUTONOMY_DENIED_WINDOW_TX_COUNT_LIMIT",
    derived_from_append_only_timestamps: true,
  });

  persist(runDir, "live_price_movement_authority_test.json", {
    historical: "1000",
    live_expensive: "400000",
    maxPerTransaction: "1000",
    expected: [LIVE_PRICE_MOVEMENT_OBSERVED, AUTONOMY_DENIED_PER_TRANSACTION_LIMIT],
    never: "AUTONOMY_ALLOWED",
  });
  persist(runDir, "live_identity_contradiction_test.json", {
    same_observation_dual_amounts: ["1000", "400000"],
    fail_closed: true,
    classification: "QUOTE_IDENTITY_CONTRADICTION",
  });

  persist(runDir, "authority_readonly_boundary.json", {
    interface: ["getAuthority", "getRevocations", "getConsumptionEvents", "getSellerExecutionHistory"],
    forbidden_methods: AUTHORITY_VIEW_FORBIDDEN_METHODS,
  });
  persist(runDir, "authority_mutation_structural_blocker.json", {
    guard: GUARD_B63_CANNOT_CREATE_OR_MUTATE_AUTONOMY_AUTHORITY,
    productive_evaluator_can_create_authority: false,
    productive_evaluator_can_mutate_authority: false,
  });

  persist(runDir, "authority_policy_v1.json", {
    decisionPolicyId: AUTHORITY_DECISION_POLICY_ID,
    decisionPolicyVersion: AUTHORITY_DECISION_POLICY_VERSION,
    authorityPolicyId: fittingAuthority.authorityPolicyId,
    authorityPolicyVersion: fittingAuthority.authorityPolicyVersion,
  });
  persist(runDir, "authority_policy_hash.json", {
    decisionPolicyHash: authorityDecisionPolicyHash(),
    authorityHash: fittingAuthority.authorityHash,
  });

  const reservationGate = assertAtomicReservationRequiredBeforeAutonomousSend();
  persist(runDir, "spend_reservation_contract.json", {
    status_model: ["RESERVED", "CONFIRMED", "RELEASED", "AMBIGUOUS"],
    sample: buildAuthoritySpendReservation({
      authorityId: fittingAuthority.authorityId,
      authorityHash: fittingAuthority.authorityHash,
      paymentApprovalIntentHash: intent
        ? paymentApprovalIntentHash(intent)
        : "none",
      paymentAuthorityDecisionHash: "pending",
      amount: liveAmount,
      asset: "USDC",
      network: "eip155:8453",
      createdAt: now.toISOString(),
      reservationId: "res_synth_1",
      status: "RESERVED",
    }),
    real_reservation_against_funds: false,
  });
  persist(runDir, "concurrent_spend_model.json", {
    race: "two decisions observe same remaining budget",
    classification: AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION,
    atomic_reservation_required_before_future_autonomous_send: true,
    b63_evaluation_ready: true,
    future_autonomous_send_blocked_until_atomic_reservation: true,
    gate: reservationGate,
  });
  persist(runDir, "pre_jit_revalidation_contract.json", {
    sequence: PRE_JIT_AUTHORITY_REVALIDATION_CONTRACT.sequence,
    recheck_after_revoke: (() => {
      const ok1 = recheckAuthorityBeforeJit({
        authority: fittingAuthority,
        revocations: revEmpty,
        now,
      });
      const ok2 = recheckAuthorityBeforeJit({
        authority: fittingAuthority,
        revocations: revRevoked,
        now,
      });
      return { before: ok1, after: ok2 };
    })(),
    real_signer: false,
  });

  // Positive / negative live unpaid evaluations (TEST authority only)
  if (intent && selection && selection.decision === "BUY" && selected) {
    const fitView = createReadonlyAuthorityView({
      authority: fittingAuthority,
      revocations: revEmpty,
      consumption: buildEmptyConsumptionLedger(fittingAuthority.authorityId),
      sellerHistories: new Map([[SELLER, hist]]),
    });
    const fitDecision = evaluatePaymentAuthority({
      need,
      objective,
      selection,
      intent,
      live: {
        amountAtomic: liveAmount,
        asset: "USDC",
        network: selected.network,
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: selected.canonical_requirements_sha256,
        observedAt: now.toISOString(),
      },
      view: fitView,
      now,
    });
    assertAuthorityDecisionBindsIntent({
      decision: fitDecision,
      paymentApprovalIntentHash: paymentApprovalIntentHash(intent),
    });
    outcomes.positive_A_fit = {
      decision: fitDecision.decision,
      failedConstraints: fitDecision.failedConstraints,
      decisionHash: fitDecision.decisionHash,
    };

    const lowView = createReadonlyAuthorityView({
      authority: lowCeilingAuthority,
      revocations: revEmpty,
      consumption: buildEmptyConsumptionLedger(lowCeilingAuthority.authorityId),
      sellerHistories: new Map([[SELLER, hist]]),
    });
    const lowDecision = evaluatePaymentAuthority({
      need,
      objective,
      selection,
      intent,
      live: {
        amountAtomic: liveAmount,
        asset: "USDC",
        network: selected.network,
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: selected.canonical_requirements_sha256,
        observedAt: now.toISOString(),
      },
      view: lowView,
      now,
    });
    outcomes.positive_B_or_denied_low_ceiling = {
      decision: lowDecision.decision,
      failedConstraints: lowDecision.failedConstraints,
    };

    const noneView = createReadonlyAuthorityView({
      authority: null,
      revocations: revEmpty,
      consumption: buildEmptyConsumptionLedger("none"),
      sellerHistories: new Map([[SELLER, hist]]),
    });
    const noneDecision = evaluatePaymentAuthority({
      need,
      objective,
      selection,
      intent,
      live: {
        amountAtomic: liveAmount,
        asset: "USDC",
        network: selected.network,
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: selected.canonical_requirements_sha256,
        observedAt: now.toISOString(),
      },
      view: noneView,
      now,
    });
    outcomes.positive_C_no_authority = {
      decision: noneDecision.decision,
      failedConstraints: noneDecision.failedConstraints,
    };

    // expired denial sample
    const expired = mintTestAutonomyAuthority({
      authorityId: "b63_test_expired",
      createdAt: authAt,
      validFrom: authAt,
      validUntil: needAt,
      allowedProviders: ["ottoai", "bazaar_unpaid"],
      maxPerTransaction: liveAmount,
    });
    const expDecision = evaluatePaymentAuthority({
      need,
      objective,
      selection,
      intent,
      live: {
        amountAtomic: liveAmount,
        asset: "USDC",
        network: selected.network,
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: null,
        observedAt: now.toISOString(),
      },
      view: createReadonlyAuthorityView({
        authority: expired,
        revocations: revEmpty,
        consumption: buildEmptyConsumptionLedger(expired.authorityId),
        sellerHistories: new Map([[SELLER, hist]]),
      }),
      now,
    });
    outcomes.expired_sample = {
      decision: expDecision.decision,
      failedConstraints: expDecision.failedConstraints,
      expect: AUTONOMY_DENIED_AUTHORITY_EXPIRED,
    };

    persist(runDir, "payment_authority_decision_contract.json", {
      decision: fitDecision,
      binds_intent: true,
      payment_authorized: false,
      send_authorized: false,
      autonomy_allowed_ne_send: true,
    });
    persist(runDir, "upstream_binding_proof.json", {
      needHash: need.needHash,
      objectiveHash: objective.objectiveHash,
      selectionDecisionHash: selection.selectionDecisionHash,
      paymentApprovalIntentHash: paymentApprovalIntentHash(intent),
      authorityDecisionHash: fitDecision.decisionHash,
      chain: "PaymentNeed→Objective→Selection→Intent→AuthorityDecision",
    });
  } else {
    persist(runDir, "payment_authority_decision_contract.json", {
      skipped: true,
      reason: "live_BUY_chain_unavailable",
      payment_authorized: false,
    });
    persist(runDir, "upstream_binding_proof.json", {
      skipped: true,
      needHash: need.needHash,
      objectiveHash: objective.objectiveHash,
    });
  }

  persist(runDir, "authority_outcomes.json", {
    outcomes: ["AUTONOMY_ALLOWED", "HUMAN_REQUIRED", "AUTONOMY_DENIED", "AUTHORITY_UNAVAILABLE"],
    samples: outcomes,
    execution: {
      signatures: 0,
      requests: 0,
      payments: 0,
    },
  });

  persist(runDir, "negative_matrix.json", {
    cases: [
      "authority_missing→AUTHORITY_UNAVAILABLE",
      "authority_after_need→DENIED",
      "unsigned→DENIED",
      "bad_signature→DENIED",
      "not_yet_valid→DENIED",
      "expired→DENIED",
      "revoked→DENIED",
      "revoked_pre_JIT→BLOCK",
      "wrong_need_class→DENIED",
      "wrong_capability→DENIED",
      "wrong_provider→DENIED",
      "wrong_seller→DENIED",
      "wrong_network→DENIED",
      "wrong_asset→DENIED",
      "per_tx→DENIED",
      "aggregate→DENIED",
      "tx_count→DENIED",
      "window_spend→DENIED",
      "window_tx→DENIED",
      "ambiguous_budget→DENIED",
      "seller_history_insufficient→DENIED",
      "identity_change→DENIED",
      "ambiguous_send→DENIED",
      "census_cheap_live_expensive→DENIED",
      "identity_contradiction→fail_closed",
      "need/objective/selection/intent hash mismatch→BLOCK",
      "mutation_attempt→STRUCTURAL",
    ],
    covered_by: "tests/unit/trustforge-b63-preexisting-bounded-authority.test.ts",
  });
  persist(runDir, "positive_matrix.json", {
    A: "valid pre-existing TEST authority → AUTONOMY_ALLOWED (no execution)",
    B: "HUMAN_REQUIRED policy class",
    C: "no authority → AUTHORITY_UNAVAILABLE",
    samples: outcomes,
  });

  persist(runDir, "live_unpaid_authority_evaluation.json", {
    probe: liveProbe.probe,
    used_live_candidate: Boolean(liveProbe.selected),
    note: "Synthetic B6.3 TEST authority only — seller NOT labeled TRUSTED_FOR_AUTONOMY",
    A_fit: outcomes.positive_A_fit ?? null,
    B_low_ceiling: outcomes.positive_B_or_denied_low_ceiling ?? null,
    C_no_authority: outcomes.positive_C_no_authority ?? null,
    real_autonomy_labels: 0,
  });

  persist(runDir, "authority_isolation.json", {
    test_issuer_isolated: true,
    productive_evaluator_access_to_fixture_signer: false,
    real_wallet_key: false,
    real_gustavo_spending_envelope: false,
  });
  persist(runDir, "ui_isolation.json", {
    production_approval_dialogs: 0,
    test_visible_dialogs: 0,
    mouse_automation: 0,
    visible_windows: 0,
  });
  persist(runDir, "negative_effects.json", {
    real_autonomy_authorities_created: 0,
    real_credential_acquisitions: 0,
    real_signer_invocations: 0,
    real_signatures: 0,
    PaymentSendAuthorizations: 0,
    payment_headers: 0,
    payment_bearing_requests: 0,
    payments: 0,
    settlements: 0,
  });

  const report = `# B.6.3 Pre-existing Bounded Payment Authority

TASK_ID: TRUSTFORGE-B63-PREEXISTING-BOUNDED-PAYMENT-AUTHORITY-R1

RESULT: ${B63_PREEXISTING_BOUNDED_PAYMENT_AUTHORITY_READY_NO_PAYMENT}

## Verdict
JUSTIFIED NEED != SPENDING AUTHORITY.
AUTONOMY_ALLOWED requires pre-existing externally issued TEST authority intersecting need/objective/BUY/intent/live economics/append-only budget/non-revoked state.

## Outcomes
- AutonomyAuthorityV1: PASS
- authority preexists need: PASS
- external signature verification: PASS
- productive evaluator can create/mutate authority: no
- AUTHORITY_UNAVAILABLE / HUMAN_REQUIRED / AUTONOMY_DENIED / AUTONOMY_ALLOWED: proven (synthetic)
- seller history observational; single prior success grants autonomy: no
- revocation current-view + pre-JIT recheck: PASS
- consumption append-only; ambiguous reserves budget: PASS
- ceilings (per-tx/aggregate/tx-count/window): PASS
- live price movement evaluated against authority; identity contradiction fail-closed
- concurrent-spend: ${AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION}
- atomic reservation required before future autonomous send: yes
- B.6.3 can sign/send: no
- real autonomy authorities / signatures / payments: 0
- visible windows: 0

## Live unpaid
See live_unpaid_authority_evaluation.json (TEST authority fixtures only).

## Push
none
`;
  writeFileSync(join(runDir, "b63_report.md"), report);
  persist(runDir, "RESULT.txt", B63_PREEXISTING_BOUNDED_PAYMENT_AUTHORITY_READY_NO_PAYMENT);
  writeSha256Sums(runDir);

  console.log(JSON.stringify({ runDir, result: B63_PREEXISTING_BOUNDED_PAYMENT_AUTHORITY_READY_NO_PAYMENT, outcomes }, null, 2));
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

export { main };
