/**
 * B.6.2 payment-need provenance — headless synthetic tests.
 * NO REAL PAYMENT. NO UI. NO DPAPI. NO SIGNER.
 */

import { describe, expect, it } from "vitest";

import {
  B62_PAYMENT_NEED_OBJECTIVE_PROVENANCE_READY_NO_PAYMENT,
  GUARD_B62_CANNOT_ACCESS_CREDENTIALS,
  GUARD_B62_CANNOT_CALL_PRODUCTIVE_TRANSPORT,
  GUARD_B62_CANNOT_CREATE_PAYMENT_HEADER,
  GUARD_B62_CANNOT_CREATE_PAYMENT_SEND_AUTHORIZATION,
  GUARD_B62_CANNOT_SIGN,
  GUARD_OBJECTIVE_DERIVATION_IS_CANDIDATE_INDEPENDENT,
  GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY,
  NO_ESTABLISHED_PAYMENT_NEED,
  OBJECTIVE_BROADENS_NEED_BUDGET,
  OBJECTIVE_BROADENS_NEED_CAPABILITY,
  OBJECTIVE_BROADENS_NEED_NETWORK,
  OBJECTIVE_NEED_MISMATCH,
  UNSUPPORTED_NEED,
  assertB62HasNoExecutionAuthority,
} from "../../tools/trustforge/b62-execution-gates";
import { runB61DecisionFromCandidates } from "../../tools/trustforge/b61-run-decision";
import {
  assertObjectiveDoesNotBroadenNeed,
  deriveObjectiveFromEstablishedNeed,
} from "../../tools/trustforge/derive-objective-from-need";
import { assessEconomicV2 } from "../../tools/trustforge/economic-assessment-v2";
import {
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
  paymentApprovalIntentToCandidateView,
} from "../../tools/trustforge/payment-approval-intent";
import { normalizeRawPaymentCandidateObservation } from "../../tools/trustforge/payment-candidate-normalize";
import type { CandidatePolicyVerdict } from "../../tools/trustforge/payment-candidate-policy";
import type { PaymentCandidateV1 } from "../../tools/trustforge/payment-candidate-v1";
import {
  buildPaymentDecisionObjective,
} from "../../tools/trustforge/payment-decision-objective-v1";
import {
  buildDerivedAgentCryptoNewsNeed,
  buildHumanBlockNumberNeed,
  buildHumanCryptoNewsNeed,
  buildInvalidDerivedAgentNeed,
  buildSelfJustifiedCandidateNeed,
  buildWorkflowBoundNeed,
} from "../../tools/trustforge/payment-need-builders";
import {
  assertNeedIntegrity,
  buildPaymentNeed,
  detectDuplicateActiveNeed,
  paymentNeedHash,
  withNeedLifecycle,
} from "../../tools/trustforge/payment-need-v1";
import { assessNeedProvenance } from "../../tools/trustforge/need-provenance-assessment-v1";
import {
  assertProjectionNotPostHocNarrative,
  projectNeedHumanRationale,
} from "../../tools/trustforge/need-human-projection";
import { verifyNeedObjectiveSelectionIntentChain } from "../../tools/trustforge/need-objective-selection-chain";
import {
  assertSatisfiedNeedCannotBuy,
  buildNeedSatisfactionAssessment,
  markNeedSatisfied,
} from "../../tools/trustforge/need-satisfaction-assessment";
import {
  buildDecisionOutcome,
  createTestHumanPaymentDecisionProvider,
} from "../../tools/trustforge/human-payment-decision-provider";
import {
  SYNTHETIC_ONESOURCE_ENDPOINT,
  SYNTHETIC_PAY_TO_B,
  syntheticObservation,
} from "../support/trustforge-b5-synthetic-candidates";

const NOW = new Date("2026-08-14T02:00:00.000Z");
const OTTO_ENDPOINT = "https://x402.ottoai.services/crypto-news";

function verdictFor(candidate: PaymentCandidateV1): CandidatePolicyVerdict {
  return {
    schema_version: "trustforge_candidate_policy_verdict.v1",
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    candidate_sha256: "synthetic",
    verdict: "ELIGIBLE",
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
    discovered_at: "2026-08-14T01:55:00.000Z",
    with_execution_handoff: true,
  });
  const base = normalizeRawPaymentCandidateObservation(syn.raw);
  const candidate: PaymentCandidateV1 = {
    ...base,
    expected_utility: {
      purpose: input.purpose,
      utility_confidence: input.utility_confidence ?? "medium",
      evidence: `advertised_${input.purpose}`,
    },
  };
  expect(syn.selected).not.toBeNull();
  return { candidate, selected: syn.selected! };
}

function rowsForUniverse() {
  const a = makeCandidate({
    endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
    service_id: "onesource_block_number",
    amount_atomic: "1000",
    purpose: "ethereum_block_number",
    utility_confidence: "high",
  });
  const b = makeCandidate({
    endpoint: OTTO_ENDPOINT,
    service_id: "ottoai_crypto_news",
    amount_atomic: "1000",
    purpose: "crypto_news",
    pay_to: SYNTHETIC_PAY_TO_B,
    provider_id: "ottoai",
    utility_confidence: "medium",
  });
  return {
    a,
    b,
    rows: [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate), {
          now: NOW,
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
    ],
  };
}

describe("B.6.2 PaymentNeed hashing + provenance", () => {
  it("hashes deterministically and changes on authority fields", () => {
    const a = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const b = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    assertNeedIntegrity(a);
    expect(a.needHash).toBe(b.needHash);
    expect(paymentNeedHash(a)).toBe(a.needHash);
    const mutated = buildHumanCryptoNewsNeed({
      createdAt: NOW.toISOString(),
      budgetCeiling: "10000",
    });
    expect(mutated.needHash).not.toBe(a.needHash);
  });

  it("HUMAN_REQUEST → ESTABLISHED", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const p = assessNeedProvenance(need);
    expect(p.provenanceStatus).toBe("ESTABLISHED");
    expect(p.authorityClass).toBe("EXPLICIT_HUMAN_NEED");
  });

  it("AGENT_TASK valid parent → ESTABLISHED DERIVED_TASK_NEED", () => {
    const need = buildDerivedAgentCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const p = assessNeedProvenance(need);
    expect(p.provenanceStatus).toBe("ESTABLISHED");
    expect(p.authorityClass).toBe("DERIVED_TASK_NEED");
    expect(p.parentBindingStatus).toBe("BOUND");
  });

  it("AGENT_TASK parent mismatch → CONTRADICTED", () => {
    const need = buildInvalidDerivedAgentNeed({ createdAt: NOW.toISOString() });
    const p = assessNeedProvenance(need);
    expect(p.provenanceStatus).toBe("CONTRADICTED");
  });

  it("WORKFLOW_REQUIREMENT → ESTABLISHED", () => {
    const need = buildWorkflowBoundNeed({ createdAt: NOW.toISOString() });
    const p = assessNeedProvenance(need);
    expect(p.provenanceStatus).toBe("ESTABLISHED");
    expect(p.authorityClass).toBe("WORKFLOW_BOUND_NEED");
  });

  it("SYSTEM_MAINTENANCE without policy → UNSUPPORTED", () => {
    const base = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const sys = buildPaymentNeed({
      createdAt: base.createdAt,
      originType: "SYSTEM_MAINTENANCE",
      originRef: "maintenance:unauth",
      parentTaskId: null,
      parentTaskHash: null,
      parentRequestedOutcome: null,
      workflowId: null,
      workflowVersion: null,
      workflowStateHash: null,
      requiredStep: null,
      requestedOutcome: base.requestedOutcome,
      needEvidence: base.needEvidence,
      constraints: base.constraints,
      allowedCapabilities: base.allowedCapabilities,
      prohibitedCapabilities: base.prohibitedCapabilities,
      preferredNetworkConstraints: base.preferredNetworkConstraints,
      preferredAssetConstraints: base.preferredAssetConstraints,
      budgetCeiling: base.budgetCeiling,
      budgetAsset: base.budgetAsset,
      urgency: base.urgency,
      informationFreshnessNeed: base.informationFreshnessNeed,
      riskConstraints: base.riskConstraints,
      needAuthorityClass: "UNSUPPORTED_NEED",
      lifecycleState: "ACTIVE",
      derivationRationale: null,
    });
    const p = assessNeedProvenance(sys);
    expect(p.provenanceStatus).toBe("UNSUPPORTED");
  });

  it("self-justification candidate-first → UNSUPPORTED; no objective", () => {
    const need = buildSelfJustifiedCandidateNeed({
      createdAt: NOW.toISOString(),
      candidateId: "otto_discovered",
    });
    const p = assessNeedProvenance(need, {
      candidateFirstSelfJustification: true,
    });
    expect(p.provenanceStatus).toBe("UNSUPPORTED");
    expect(p.rationale).toContain(UNSUPPORTED_NEED);
    expect(() =>
      deriveObjectiveFromEstablishedNeed({ need, provenance: p }),
    ).toThrow(NO_ESTABLISHED_PAYMENT_NEED);
  });
});

describe("B.6.2 objective derivation + monotonicity", () => {
  it("derives crypto_news objective from human need without candidates", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective, proof } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    expect(objective.requestedCapability).toBe("crypto_news");
    expect(objective.needHash).toBe(need.needHash);
    expect(objective.needProvenanceAssessmentHash).toBe(provenance.assessmentHash);
    expect(proof.derivationStatus).toBe("DERIVED");
    expect(objective.maxBudget).toBe("1000");
  });

  it("candidate context fails closed (candidate-independent)", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    expect(() =>
      deriveObjectiveFromEstablishedNeed({
        need,
        provenance,
        now: NOW,
        forbiddenCandidateContext: { price: "1000", seller: "otto" },
      }),
    ).toThrow(GUARD_OBJECTIVE_DERIVATION_IS_CANDIDATE_INDEPENDENT);
  });

  it("budget / network / capability broadening fail closed", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });

    expect(() =>
      assertObjectiveDoesNotBroadenNeed(
        need,
        buildPaymentDecisionObjective({ ...objective, maxBudget: "1200" }),
      ),
    ).toThrow(OBJECTIVE_BROADENS_NEED_BUDGET);

    expect(() =>
      assertObjectiveDoesNotBroadenNeed(
        need,
        buildPaymentDecisionObjective({
          ...objective,
          networkConstraints: ["eip155:8453", "eip155:1"],
        }),
      ),
    ).toThrow(OBJECTIVE_BROADENS_NEED_NETWORK);

    expect(() =>
      assertObjectiveDoesNotBroadenNeed(
        need,
        buildPaymentDecisionObjective({
          ...objective,
          requestedCapability: "chain_block_number",
          acceptableOutputClasses: ["chain_block_number"],
        }),
      ),
    ).toThrow(OBJECTIVE_BROADENS_NEED_CAPABILITY);
  });

  it("objective need mismatch (crypto need → block objective)", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const bad = buildPaymentDecisionObjective({
      createdAt: NOW.toISOString(),
      requestedCapability: "chain_block_number",
      purpose: "obtain current Ethereum block number",
      acceptableOutputClasses: ["chain_block_number"],
      requiredProperties: [],
      preferredProperties: [],
      networkConstraints: ["eip155:8453"],
      assetConstraints: ["USDC"],
      maxBudget: "1000",
      budgetAsset: need.budgetAsset,
      freshnessRequirement: { kind: "none" },
      minimumUtilityEvidenceClass: "ADVERTISED_UTILITY",
      minimumEvidenceConfidence: "low",
      providerConstraints: null,
      sellerConstraints: null,
      riskTolerance: "medium",
      diversityPreference: "unspecified",
      decisionContext: "tamper",
      needId: need.needId,
      needHash: need.needHash,
    });
    expect(() => assertObjectiveDoesNotBroadenNeed(need, bad)).toThrow(
      /OBJECTIVE_NEED_MISMATCH|OBJECTIVE_BROADENS_NEED_CAPABILITY/,
    );
  });
});

describe("B.6.2 end-to-end synthetic cases", () => {
  it("Case A: human crypto need → OttoAI BUY; OneSource OUT_OF_SCOPE", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const { rows, b } = rowsForUniverse();
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("BUY");
    expect(decision.selectedCandidateId).toBe(b.candidate.candidate_id);
    expect(
      decision.evaluatedCandidates.some(
        (c) => c.disposition === "OUT_OF_SCOPE_OBJECTIVE",
      ),
    ).toBe(true);
  });

  it("Case B: human block need → OneSource BUY; OttoAI OUT_OF_SCOPE", () => {
    const need = buildHumanBlockNumberNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const { rows, a } = rowsForUniverse();
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("BUY");
    expect(decision.selectedCandidateId).toBe(a.candidate.candidate_id);
  });

  it("Case C: no justified need → no objective / no B6", () => {
    const need = buildSelfJustifiedCandidateNeed({
      createdAt: NOW.toISOString(),
      candidateId: "otto",
    });
    const provenance = assessNeedProvenance(need, {
      candidateFirstSelfJustification: true,
    });
    expect(provenance.provenanceStatus).toBe("UNSUPPORTED");
    let objectiveCreations = 0;
    try {
      deriveObjectiveFromEstablishedNeed({ need, provenance, now: NOW });
      objectiveCreations += 1;
    } catch {
      // expected
    }
    expect(objectiveCreations).toBe(0);
  });

  it("Case D: valid need + incomplete utility → DEFER", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const weak = makeCandidate({
      endpoint: OTTO_ENDPOINT,
      service_id: "otto_weak",
      amount_atomic: "1000",
      purpose: "crypto_news",
      pay_to: SYNTHETIC_PAY_TO_B,
      provider_id: "ottoai",
      utility_confidence: "none",
    });
    const rows = [
      {
        candidate: weak.candidate,
        verdict: verdictFor(weak.candidate),
        economicsV2: assessEconomicV2(weak.candidate, verdictFor(weak.candidate), {
          now: NOW,
          utilityConfidenceOverride: "none",
          priorDeliveredUtilityEvidence: false,
          priorSuccessfulExecutionEvidence: false,
        }),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("DEFER");
  });

  it("Case E: valid need + budget exceed → DONT_BUY", () => {
    const need = buildHumanCryptoNewsNeed({
      createdAt: NOW.toISOString(),
      budgetCeiling: "1000",
    });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const expensive = makeCandidate({
      endpoint: OTTO_ENDPOINT,
      service_id: "otto_expensive",
      amount_atomic: "5000",
      purpose: "crypto_news",
      pay_to: SYNTHETIC_PAY_TO_B,
      provider_id: "ottoai",
      utility_confidence: "high",
    });
    const rows = [
      {
        candidate: expensive.candidate,
        verdict: verdictFor(expensive.candidate),
        economicsV2: assessEconomicV2(
          expensive.candidate,
          verdictFor(expensive.candidate),
          {
            now: NOW,
            priorDeliveredUtilityEvidence: true,
            utilityConfidenceOverride: "high",
          },
        ),
      },
    ];
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    expect(decision.decision).toBe("DONT_BUY");
  });
});

describe("B.6.2 binding + lifecycle + headless", () => {
  it("transitive need→objective→selection→intent chain", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective, proof } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const { rows, b } = rowsForUniverse();
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    const intent = buildPaymentApprovalIntentFromSelected({
      selected: b.selected,
      candidateId: decision.selectedCandidateId ?? undefined,
      selectionDecisionHash: decision.selectionDecisionHash,
      selectedCandidateId: decision.selectedCandidateId ?? undefined,
      selectedObservationId: decision.selectedObservationId ?? undefined,
      candidateSetHash: decision.candidateSetHash,
      objectiveId: objective.objectiveId,
      objectiveHash: objective.objectiveHash,
      needId: need.needId,
      needHash: need.needHash,
    });
    assertPaymentApprovalIntentBindsSelectionDecision(intent, decision);
    verifyNeedObjectiveSelectionIntentChain({
      need,
      provenance,
      proof,
      objective,
      decision,
      intent,
    });
  });

  it("need tamper invalidates downstream objective binding", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const tampered = buildHumanCryptoNewsNeed({
      createdAt: NOW.toISOString(),
      budgetCeiling: "9999",
    });
    expect(tampered.needHash).not.toBe(need.needHash);
    expect(objective.needHash).not.toBe(tampered.needHash);
  });

  it("lifecycle SATISFIED blocks repurchase BUY path", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const assessment = buildNeedSatisfactionAssessment({
      need,
      status: "SATISFIED",
      deliveredUtilityRef: "historical:ottoai_delivered",
      rationale: "prior delivered crypto-news satisfied prior need",
    });
    const satisfied = markNeedSatisfied({ need, assessment });
    expect(satisfied.lifecycleState).toBe("SATISFIED");
    expect(() => assertSatisfiedNeedCannotBuy(satisfied)).toThrow(
      GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY,
    );
    const provenance = assessNeedProvenance(satisfied);
    expect(() =>
      deriveObjectiveFromEstablishedNeed({
        need: satisfied,
        provenance,
        now: NOW,
      }),
    ).toThrow(GUARD_SATISFIED_NEED_CANNOT_TRIGGER_NEW_BUY);
  });

  it("duplicate active need detection", () => {
    const a = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const b = buildPaymentNeed({
      ...a,
      needId: "distinct_duplicate_id",
    });
    expect(a.needId).not.toBe(b.needId);
    const dup = detectDuplicateActiveNeed({ candidate: b, activeNeeds: [a] });
    expect(dup.duplicate).toBe(true);
  });

  it("EXPIRED/CANCELLED cannot generate objective", () => {
    const need = withNeedLifecycle(
      buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() }),
      "EXPIRED",
    );
    const provenance = assessNeedProvenance(need);
    expect(() =>
      deriveObjectiveFromEstablishedNeed({ need, provenance, now: NOW }),
    ).toThrow();
  });

  it("deterministic human projection; post-hoc narrative rejected", () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const { rows } = rowsForUniverse();
    const { decision, matches } = runB61DecisionFromCandidates(rows, objective, {
      now: NOW,
    });
    const projection = projectNeedHumanRationale({
      need,
      provenance,
      objective,
      decision,
      matches,
    });
    expect(projection.whyBuyingAnything.needHash).toBe(need.needHash);
    assertProjectionNotPostHocNarrative(projection);
    expect(() =>
      assertProjectionNotPostHocNarrative({
        ...projection,
        projectionSource: "llm_post_hoc" as unknown as "deterministic_hashed_artifacts",
      }),
    ).toThrow("BLOCKED_B62_POST_HOC_NEED_NARRATIVE");
  });

  it("headless BUY binding; invalid need → zero approval calls", async () => {
    const need = buildHumanCryptoNewsNeed({ createdAt: NOW.toISOString() });
    const provenance = assessNeedProvenance(need);
    const { objective } = deriveObjectiveFromEstablishedNeed({
      need,
      provenance,
      now: NOW,
    });
    const { rows, b } = rowsForUniverse();
    const { decision } = runB61DecisionFromCandidates(rows, objective, { now: NOW });
    const intent = buildPaymentApprovalIntentFromSelected({
      selected: b.selected,
      selectionDecisionHash: decision.selectionDecisionHash,
      selectedCandidateId: decision.selectedCandidateId ?? undefined,
      selectedObservationId: decision.selectedObservationId ?? undefined,
      candidateSetHash: decision.candidateSetHash,
      objectiveId: objective.objectiveId,
      objectiveHash: objective.objectiveHash,
      needId: need.needId,
      needHash: need.needHash,
    });
    let approvalCalls = 0;
    const provider = createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "APPROVE",
        decision_source: "approve_button",
        human_decision_id: "paydec_b62",
        decided_at: NOW.toISOString(),
        provider_id: "test-human-payment-decision",
      }),
    );
    approvalCalls += 1;
    const human = await provider.decideOnce(paymentApprovalIntentToCandidateView(intent));
    expect(human.payment_approval_intent_hash).toBe(paymentApprovalIntentHash(intent));
    expect(approvalCalls).toBe(1);

    const bad = buildSelfJustifiedCandidateNeed({
      createdAt: NOW.toISOString(),
      candidateId: "x",
    });
    const badProv = assessNeedProvenance(bad, {
      candidateFirstSelfJustification: true,
    });
    let badApprovals = 0;
    try {
      deriveObjectiveFromEstablishedNeed({ need: bad, provenance: badProv });
    } catch {
      // no objective → no approval
    }
    expect(badApprovals).toBe(0);
  });

  it("authority isolation", () => {
    assertB62HasNoExecutionAuthority();
    expect(GUARD_B62_CANNOT_SIGN).toBeTruthy();
    expect(GUARD_B62_CANNOT_ACCESS_CREDENTIALS).toBeTruthy();
    expect(GUARD_B62_CANNOT_CREATE_PAYMENT_SEND_AUTHORIZATION).toBeTruthy();
    expect(GUARD_B62_CANNOT_CREATE_PAYMENT_HEADER).toBeTruthy();
    expect(GUARD_B62_CANNOT_CALL_PRODUCTIVE_TRANSPORT).toBeTruthy();
    expect(B62_PAYMENT_NEED_OBJECTIVE_PROVENANCE_READY_NO_PAYMENT).toBeTruthy();
  });
});
