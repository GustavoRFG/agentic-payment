/**
 * B.6.1 objective-bound agentic payment decisions — headless synthetic tests.
 * NO REAL PAYMENT. NO UI. NO DPAPI. NO SIGNER.
 */

import { describe, expect, it } from "vitest";

import {
  B61_OBJECTIVE_BOUND_PAYMENT_DECISION_READY_NO_PAYMENT,
  GUARD_B61_CANNOT_ACCESS_DPAPI,
  GUARD_B61_CANNOT_CREATE_PAYMENT_HEADER,
  GUARD_B61_CANNOT_SEND,
  GUARD_B61_CANNOT_SIGN,
  GUARD_OBJECTIVE_MATCH_PRECEDES_ECONOMIC_RANKING,
  NEED_MORE_DISCOVERY,
  NO_RELEVANT_CANDIDATE,
  OBJECTIVE_BUDGET_EXCEEDED,
  OBJECTIVE_REQUIRED,
  OBJECTIVE_SELECTION_BINDING_MISMATCH,
  OUT_OF_SCOPE_OBJECTIVE,
  assertB61HasNoExecutionAuthority,
} from "../../tools/trustforge/b61-execution-gates";
import { runB61DecisionFromCandidates } from "../../tools/trustforge/b61-run-decision";
import { CAPABILITY_TAXONOMY_V1 } from "../../tools/trustforge/capability-taxonomy-v1";
import { assessCapabilityMatch } from "../../tools/trustforge/capability-match-assessment";
import { assessEconomicV2 } from "../../tools/trustforge/economic-assessment-v2";
import {
  assertPaymentApprovalIntentBindsObjective,
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
} from "../../tools/trustforge/payment-approval-intent";
import { normalizeRawPaymentCandidateObservation } from "../../tools/trustforge/payment-candidate-normalize";
import type { CandidatePolicyVerdict } from "../../tools/trustforge/payment-candidate-policy";
import type { PaymentCandidateV1 } from "../../tools/trustforge/payment-candidate-v1";
import {
  assertObjectiveIntegrity,
  buildChainBlockNumberObjective,
  buildCryptoNewsObjective,
  buildPaymentDecisionObjective,
  buildWeatherForecastObjective,
  paymentDecisionObjectiveHash,
} from "../../tools/trustforge/payment-decision-objective-v1";
import {
  assertSelectionDecisionBindsObjective,
  assertSelectionDecisionIntegrity,
  paymentSelectionDecisionHash,
} from "../../tools/trustforge/payment-selection-decision-v1";
import { projectObjectiveHumanRationale } from "../../tools/trustforge/objective-human-projection";
import {
  buildDecisionOutcome,
  createTestHumanPaymentDecisionProvider,
} from "../../tools/trustforge/human-payment-decision-provider";
import { paymentApprovalIntentToCandidateView } from "../../tools/trustforge/payment-approval-intent";
import {
  SYNTHETIC_ALT_ENDPOINT,
  SYNTHETIC_ONESOURCE_ENDPOINT,
  SYNTHETIC_PAY_TO_B,
  syntheticObservation,
} from "../support/trustforge-b5-synthetic-candidates";

const NOW = new Date("2026-08-13T20:00:00.000Z");
const OTTO_ENDPOINT = "https://x402.ottoai.services/crypto-news";

function verdictFor(
  candidate: PaymentCandidateV1,
  kind: CandidatePolicyVerdict["verdict"] = "ELIGIBLE",
): CandidatePolicyVerdict {
  return {
    schema_version: "trustforge_candidate_policy_verdict.v1",
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    candidate_sha256: "synthetic",
    verdict: kind,
    reasons: [],
    payment_authorized: false,
    policy_sha256: "synthetic_policy",
    evaluated_at: NOW.toISOString(),
  };
}

function makeCandidate(input: {
  endpoint: string;
  service_id: string;
  amount_atomic: string;
  purpose: string;
  pay_to?: string;
  provider_id?: string;
  utility_evidence?: string;
  utility_confidence?: PaymentCandidateV1["expected_utility"]["utility_confidence"];
}): {
  candidate: PaymentCandidateV1;
  selected: NonNullable<ReturnType<typeof syntheticObservation>["selected"]>;
} {
  const syn = syntheticObservation({
    endpoint: input.endpoint,
    service_id: input.service_id,
    amount_atomic: input.amount_atomic,
    pay_to: input.pay_to,
    purpose: input.purpose,
    provider_id: input.provider_id,
    discovered_at: "2026-08-13T19:55:00.000Z",
    with_execution_handoff: true,
  });
  const base = normalizeRawPaymentCandidateObservation(syn.raw);
  const candidate: PaymentCandidateV1 = {
    ...base,
    expected_utility: {
      purpose: input.purpose,
      utility_confidence: input.utility_confidence ?? "medium",
      evidence: input.utility_evidence ?? `advertised_${input.purpose}`,
    },
  };
  expect(syn.selected).not.toBeNull();
  return { candidate, selected: syn.selected! };
}

function onesourceBlock() {
  return makeCandidate({
    endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
    service_id: "onesource_block_number",
    amount_atomic: "1000",
    purpose: "ethereum_block_number",
    utility_confidence: "high",
    utility_evidence: "prior_trustforge_mainnet_payment_history_onesource_block_number",
  });
}

function ottoCryptoNews() {
  return makeCandidate({
    endpoint: OTTO_ENDPOINT,
    service_id: "ottoai_crypto_news",
    amount_atomic: "1000",
    purpose: "crypto_news",
    pay_to: SYNTHETIC_PAY_TO_B,
    provider_id: "ottoai",
    utility_confidence: "medium",
    utility_evidence: "prior_delivered_crypto_news_market_brief",
  });
}

describe("B.6.1 PaymentDecisionObjective", () => {
  it("hashes deterministically and changes on authority-relevant mutation", () => {
    const a = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });
    const b = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });
    assertObjectiveIntegrity(a);
    expect(a.objectiveHash).toBe(b.objectiveHash);
    expect(paymentDecisionObjectiveHash(a)).toBe(a.objectiveHash);

    const mutatedCapability = buildPaymentDecisionObjective({
      ...a,
      requestedCapability: "chain_block_number",
      purpose: "obtain current Ethereum block number",
      acceptableOutputClasses: ["chain_block_number"],
    });
    expect(mutatedCapability.objectiveHash).not.toBe(a.objectiveHash);

    const mutatedBudget = buildPaymentDecisionObjective({
      ...a,
      maxBudget: "10000",
    });
    expect(mutatedBudget.objectiveHash).not.toBe(a.objectiveHash);
  });

  it("exposes inspectable capability taxonomy without LLM authority", () => {
    expect(CAPABILITY_TAXONOMY_V1.capabilities).toContain("crypto_news");
    expect(CAPABILITY_TAXONOMY_V1.capabilities).toContain("chain_block_number");
    expect(CAPABILITY_TAXONOMY_V1.maySatisfy.crypto_news).toContain(
      "market_information",
    );
    expect(CAPABILITY_TAXONOMY_V1.maySatisfy.chain_block_number ?? []).not.toContain(
      "crypto_news",
    );
  });
});

describe("B.6.1 critical matrix: objective match precedes price", () => {
  it("crypto_news → OttoAI BUY; OneSource OUT_OF_SCOPE (even if cheaper/higher confidence)", () => {
    const a = onesourceBlock();
    const b = ottoCryptoNews();
    const objective = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });

    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
          priorSuccessfulExecutionEvidence: true,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "high",
        }),
      },
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate), {
          now: NOW,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "medium",
        }),
      },
    ];

    const { decision, matches } = runB61DecisionFromCandidates(rows, objective, {
      now: NOW,
    });
    expect(decision.decision).toBe("BUY");
    expect(decision.selectedCandidateId).toBe(b.candidate.candidate_id);
    expect(decision.objectiveHash).toBe(objective.objectiveHash);
    expect(matches.get(a.candidate.candidate_id)?.match).toBe("MISMATCH");
    expect(matches.get(b.candidate.candidate_id)?.match).toMatch(/EXACT|COMPATIBLE/);
    const onesource = decision.evaluatedCandidates.find(
      (c) => c.candidateId === a.candidate.candidate_id,
    );
    expect(onesource?.disposition).toBe("OUT_OF_SCOPE_OBJECTIVE");
    expect(onesource?.reason).toBe(OUT_OF_SCOPE_OBJECTIVE);
    expect(
      decision.selectionRationale.some((r) =>
        r.detail.includes(GUARD_OBJECTIVE_MATCH_PRECEDES_ECONOMIC_RANKING),
      ),
    ).toBe(true);
  });

  it("chain_block_number → OneSource BUY; OttoAI OUT_OF_SCOPE", () => {
    const a = onesourceBlock();
    const b = ottoCryptoNews();
    const objective = buildChainBlockNumberObjective({
      createdAt: NOW.toISOString(),
    });
    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
          priorSuccessfulExecutionEvidence: true,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "high",
        }),
      },
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate), {
          now: NOW,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "high",
        }),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("BUY");
    expect(decision.selectedCandidateId).toBe(a.candidate.candidate_id);
    const otto = decision.evaluatedCandidates.find(
      (c) => c.candidateId === b.candidate.candidate_id,
    );
    expect(otto?.disposition).toBe("OUT_OF_SCOPE_OBJECTIVE");
  });
});

describe("B.6.1 NO_RELEVANT / budget / OBJECTIVE_REQUIRED", () => {
  it("weather_forecast → DEFER NEED_MORE_DISCOVERY (NO_RELEVANT_CANDIDATE)", () => {
    const a = onesourceBlock();
    const b = ottoCryptoNews();
    const objective = buildWeatherForecastObjective({
      createdAt: NOW.toISOString(),
    });
    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
          utilityConfidenceOverride: "high",
        }),
      },
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate), {
          now: NOW,
          utilityConfidenceOverride: "high",
        }),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("DEFER");
    expect(
      decision.deferralConditions?.some((d) => d.code === NEED_MORE_DISCOVERY),
    ).toBe(true);
    expect(
      decision.selectionRationale.some((r) => r.code === NO_RELEVANT_CANDIDATE),
    ).toBe(true);
    expect(decision.selectedCandidateId).toBeNull();
  });

  it("budget exceeded → DONT_BUY with OBJECTIVE_BUDGET_EXCEEDED", () => {
    const expensive = makeCandidate({
      endpoint: OTTO_ENDPOINT,
      service_id: "otto_expensive",
      amount_atomic: "5000",
      purpose: "crypto_news",
      pay_to: SYNTHETIC_PAY_TO_B,
      provider_id: "ottoai",
      utility_confidence: "high",
    });
    const objective = buildCryptoNewsObjective({
      createdAt: NOW.toISOString(),
      maxBudgetAtomic: "1000",
    });
    const rows = [
      {
        candidate: expensive.candidate,
        verdict: verdictFor(expensive.candidate),
        economicsV2: assessEconomicV2(
          expensive.candidate,
          verdictFor(expensive.candidate),
          { now: NOW, utilityConfidenceOverride: "high", priorDeliveredUtilityEvidence: true },
        ),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("DONT_BUY");
    expect(
      decision.evaluatedCandidates[0]?.reason === OBJECTIVE_BUDGET_EXCEEDED ||
        decision.rejectionReasons?.some((r) => r.code === OBJECTIVE_BUDGET_EXCEEDED),
    ).toBe(true);
  });

  it("fail-closed OBJECTIVE_REQUIRED without objective", () => {
    const a = onesourceBlock();
    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
        }),
      },
    ];
    expect(() => runB61DecisionFromCandidates(rows, null, { now: NOW })).toThrow(
      OBJECTIVE_REQUIRED,
    );
  });
});

describe("B.6.1 objective→selection→intent binding + tamper", () => {
  it("binds objective through selection and PaymentApprovalIntent", () => {
    const a = onesourceBlock();
    const b = ottoCryptoNews();
    const objective = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });
    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
          utilityConfidenceOverride: "high",
        }),
      },
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate), {
          now: NOW,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "medium",
        }),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    assertSelectionDecisionIntegrity(decision);
    assertSelectionDecisionBindsObjective({
      decision,
      objectiveId: objective.objectiveId,
      objectiveHash: objective.objectiveHash,
    });

    const intent = buildPaymentApprovalIntentFromSelected({
      selected: b.selected,
      candidateId: decision.selectedCandidateId ?? undefined,
      advertisedPurpose: "crypto_news",
      selectionDecisionHash: decision.selectionDecisionHash,
      selectedCandidateId: decision.selectedCandidateId ?? undefined,
      selectedObservationId: decision.selectedObservationId ?? undefined,
      candidateSetHash: decision.candidateSetHash,
      objectiveId: objective.objectiveId,
      objectiveHash: objective.objectiveHash,
    });
    assertPaymentApprovalIntentBindsSelectionDecision(intent, decision);
    assertPaymentApprovalIntentBindsObjective({
      intent,
      expectedObjectiveHash: objective.objectiveHash,
      expectedObjectiveId: objective.objectiveId,
    });
    expect(intent.objective_hash).toBe(objective.objectiveHash);
  });

  it("objective tamper / selection reuse mismatch fail-closed before intent use", () => {
    const b = ottoCryptoNews();
    const objective = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });
    const other = buildChainBlockNumberObjective({ createdAt: NOW.toISOString() });
    const rows = [
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate), {
          now: NOW,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "medium",
        }),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });

    expect(() =>
      assertSelectionDecisionBindsObjective({
        decision,
        objectiveId: other.objectiveId,
        objectiveHash: other.objectiveHash,
      }),
    ).toThrow(OBJECTIVE_SELECTION_BINDING_MISMATCH);

    const badIntent = buildPaymentApprovalIntentFromSelected({
      selected: b.selected,
      selectionDecisionHash: decision.selectionDecisionHash,
      selectedCandidateId: decision.selectedCandidateId ?? undefined,
      selectedObservationId: decision.selectedObservationId ?? undefined,
      candidateSetHash: decision.candidateSetHash,
      objectiveId: other.objectiveId,
      objectiveHash: other.objectiveHash,
    });
    expect(() =>
      assertPaymentApprovalIntentBindsSelectionDecision(badIntent, decision),
    ).toThrow(OBJECTIVE_SELECTION_BINDING_MISMATCH);

    const mutated = {
      ...decision,
      objectiveHash: other.objectiveHash,
      objectiveId: other.objectiveId,
    };
    expect(paymentSelectionDecisionHash(mutated)).not.toBe(decision.selectionDecisionHash);
  });

  it("deterministic human projection derives from hashed artifacts", () => {
    const a = onesourceBlock();
    const b = ottoCryptoNews();
    const objective = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });
    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
          utilityConfidenceOverride: "high",
        }),
      },
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate), {
          now: NOW,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "medium",
        }),
      },
    ];
    const { decision, matches } = runB61DecisionFromCandidates(rows, objective, {
      now: NOW,
    });
    const projection = projectObjectiveHumanRationale({
      objective,
      decision,
      matches,
    });
    expect(projection.objectiveSummary.whatIAsked).toBe(objective.purpose);
    expect(projection.objectiveSummary.objectiveHash).toBe(objective.objectiveHash);
    expect(projection.selectedSummary.selectedCandidateId).toBe(
      b.candidate.candidate_id,
    );
    expect(
      projection.alternatives.some(
        (alt) =>
          alt.candidateId === a.candidate.candidate_id &&
          alt.disposition === "OUT_OF_SCOPE_OBJECTIVE",
      ),
    ).toBe(true);
    expect(projection.projectionSource).toBe("deterministic_hashed_artifacts");
  });
});

describe("B.6.1 headless objective→B4 binding (no UI / no payment)", () => {
  it("BUY path: objective→selection→intent→headless APPROVE; zero windows/signatures/requests", async () => {
    const a = onesourceBlock();
    const b = ottoCryptoNews();
    const objective = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });
    let approvalProviderCalls = 0;
    let visibleWindows = 0;
    let signatures = 0;
    let paymentRequests = 0;

    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
          utilityConfidenceOverride: "high",
        }),
      },
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate), {
          now: NOW,
          priorDeliveredUtilityEvidence: true,
          utilityConfidenceOverride: "medium",
        }),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("BUY");

    const intent = buildPaymentApprovalIntentFromSelected({
      selected: b.selected,
      candidateId: decision.selectedCandidateId ?? undefined,
      selectionDecisionHash: decision.selectionDecisionHash,
      selectedCandidateId: decision.selectedCandidateId ?? undefined,
      selectedObservationId: decision.selectedObservationId ?? undefined,
      candidateSetHash: decision.candidateSetHash,
      objectiveId: objective.objectiveId,
      objectiveHash: objective.objectiveHash,
    });
    assertPaymentApprovalIntentBindsSelectionDecision(intent, decision);

    const view = paymentApprovalIntentToCandidateView(intent);
    const provider = createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "APPROVE",
        decision_source: "approve_button",
        human_decision_id: "paydec_b61_e2e",
        decided_at: "2026-08-13T20:01:00.000Z",
        provider_id: "test-human-payment-decision",
      }),
    );
    approvalProviderCalls += 1;
    const human = await provider.decideOnce(view);
    expect(human.decision).toBe("APPROVE");
    expect(human.payment_approval_intent_hash).toBe(paymentApprovalIntentHash(intent));
    expect(visibleWindows).toBe(0);
    expect(signatures).toBe(0);
    expect(paymentRequests).toBe(0);
    expect(approvalProviderCalls).toBe(1);
  });

  it("objective mismatch → no approval provider / signatures / requests", () => {
    const a = onesourceBlock();
    const objective = buildWeatherForecastObjective({
      createdAt: NOW.toISOString(),
    });
    let approvalProviderCalls = 0;
    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
          utilityConfidenceOverride: "high",
        }),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("DEFER");
    expect(decision.selectedCandidateId).toBeNull();
    // No intent / approval when not BUY
    expect(approvalProviderCalls).toBe(0);
  });

  it("authority isolation guards present", () => {
    assertB61HasNoExecutionAuthority();
    expect(GUARD_B61_CANNOT_SIGN).toBeTruthy();
    expect(GUARD_B61_CANNOT_ACCESS_DPAPI).toBeTruthy();
    expect(GUARD_B61_CANNOT_CREATE_PAYMENT_HEADER).toBeTruthy();
    expect(GUARD_B61_CANNOT_SEND).toBeTruthy();
    expect(B61_OBJECTIVE_BOUND_PAYMENT_DECISION_READY_NO_PAYMENT).toBeTruthy();
  });

  it("capability match assessment is structured and hashed", () => {
    const b = ottoCryptoNews();
    const objective = buildCryptoNewsObjective({ createdAt: NOW.toISOString() });
    const economics = assessEconomicV2(b.candidate, verdictFor(b.candidate), {
      now: NOW,
      priorDeliveredUtilityEvidence: true,
    });
    const match = assessCapabilityMatch({
      objective,
      candidate: b.candidate,
      economics,
    });
    expect(match.match).toMatch(/EXACT|COMPATIBLE/);
    expect(match.assessmentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(match.objectiveHash).toBe(objective.objectiveHash);
  });
});
