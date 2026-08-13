/**
 * B.6 agentic payment decision layer — headless synthetic tests.
 * NO REAL PAYMENT. NO UI. NO DPAPI.
 */

import { describe, expect, it } from "vitest";

import {
  B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT,
  BLOCKED_B6_SELECTION_DECISION_TAMPER,
  BLOCKED_B6_SELECTION_STALE,
  GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION,
  GUARD_B6_CANNOT_ACCESS_CREDENTIALS,
  GUARD_B6_CANNOT_CALL_PRODUCTIVE_PAYMENT_TRANSPORT,
  GUARD_B6_CANNOT_CREATE_PAYMENT_HEADER,
  GUARD_B6_CANNOT_CREATE_PAYMENT_SEND_AUTHORIZATION,
  GUARD_B6_CANNOT_SIGN,
  GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION,
  GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET,
  assertB6HasNoExecutionAuthority,
} from "../../tools/trustforge/b6-execution-gates";
import { assertDecisionBindsCandidateSet } from "../../tools/trustforge/candidate-decision-set";
import {
  B6_DECISION_POLICY_V1,
  b6DecisionPolicyHash,
} from "../../tools/trustforge/b6-decision-policy-v1";
import { runB6DecisionFromCandidates } from "../../tools/trustforge/b6-run-decision";
import { assessEconomicV2 } from "../../tools/trustforge/economic-assessment-v2";
import {
  assertPaymentApprovalIntentBindsSelectionDecision,
  assertFreshTermsWithinPaymentApprovalIntent,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
} from "../../tools/trustforge/payment-approval-intent";
import { normalizeRawPaymentCandidateObservation } from "../../tools/trustforge/payment-candidate-normalize";
import type { CandidatePolicyVerdict } from "../../tools/trustforge/payment-candidate-policy";
import type { PaymentCandidateV1 } from "../../tools/trustforge/payment-candidate-v1";
import {
  assertSelectionDecisionFresh,
  assertSelectionDecisionIntegrity,
  paymentSelectionDecisionHash,
} from "../../tools/trustforge/payment-selection-decision-v1";
import {
  buildPriceMovementEvidence,
  classifyHistoricalVsLiveQuote,
  classifyIntraObservationContradiction,
  PRICE_CHANGE_REQUIRES_REEVALUATION,
  QUOTE_IDENTITY_CONTRADICTION,
} from "../../tools/trustforge/quote-observation-semantics";
import { BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE } from "../../tools/trustforge/b52-execution-gates";
import {
  SYNTHETIC_ALT_ENDPOINT,
  SYNTHETIC_ONESOURCE_ENDPOINT,
  SYNTHETIC_PAY_TO_B,
  syntheticObservation,
} from "../support/trustforge-b5-synthetic-candidates";

const NOW = new Date("2026-08-13T05:00:00.000Z");
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

function verdictFor(
  candidate: PaymentCandidateV1,
  kind: CandidatePolicyVerdict["verdict"],
  reasons: string[] = [],
): CandidatePolicyVerdict {
  return {
    schema_version: "trustforge_candidate_policy_verdict.v1",
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    candidate_sha256: "synthetic",
    verdict: kind,
    reasons,
    payment_authorized: false,
    policy_sha256: "synthetic_policy",
    evaluated_at: NOW.toISOString(),
  };
}

function candidateFromSynthetic(input: {
  endpoint: string;
  service_id: string;
  amount_atomic: string;
  pay_to?: string;
  purpose?: string;
  provider_id?: string;
  discovered_at?: string;
  utility_confidence?: PaymentCandidateV1["expected_utility"]["utility_confidence"];
  utility_evidence?: string;
}): PaymentCandidateV1 {
  const syn = syntheticObservation({
    endpoint: input.endpoint,
    service_id: input.service_id,
    amount_atomic: input.amount_atomic,
    pay_to: input.pay_to,
    purpose: input.purpose ?? "block_number",
    provider_id: input.provider_id,
    discovered_at: input.discovered_at ?? "2026-08-13T04:55:00.000Z",
    with_execution_handoff: true,
  });
  const base = normalizeRawPaymentCandidateObservation(syn.raw);
  return {
    ...base,
    expected_utility: {
      purpose: input.purpose ?? "block_number",
      utility_confidence: input.utility_confidence ?? "medium",
      evidence: input.utility_evidence ?? "advertised_block_number",
    },
  };
}

describe("B.6 agentic payment decision", () => {
  it("Case A: BUY with 3 candidates (useful A, weaker B, unsupported C)", () => {
    const a = candidateFromSynthetic({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "onesource_block_number",
      amount_atomic: "1000",
      purpose: "block_number",
      utility_confidence: "medium",
      utility_evidence: "prior_trustforge_mainnet_payment_history_onesource_block_number",
    });
    const b = candidateFromSynthetic({
      endpoint: SYNTHETIC_ALT_ENDPOINT,
      service_id: "alt_tip",
      amount_atomic: "3000",
      pay_to: SYNTHETIC_PAY_TO_B,
      purpose: "block_number",
      utility_confidence: "medium",
      utility_evidence: "advertised_block_number",
      provider_id: "synthetic_alt",
    });
    const c = candidateFromSynthetic({
      endpoint: "https://unsupported.example.invalid/x",
      service_id: "bad_proto",
      amount_atomic: "500",
      purpose: "block_number",
      utility_confidence: "high",
      provider_id: "unsupported_x",
    });

    const rows = [
      {
        candidate: a,
        verdict: verdictFor(a, "ELIGIBLE"),
        economicsV2: assessEconomicV2(a, verdictFor(a, "ELIGIBLE"), {
          now: NOW,
          priorSuccessfulExecutionEvidence: true,
          utilityConfidenceOverride: "medium",
        }),
      },
      {
        candidate: b,
        verdict: verdictFor(b, "ELIGIBLE"),
        economicsV2: assessEconomicV2(b, verdictFor(b, "ELIGIBLE"), {
          now: NOW,
          utilityConfidenceOverride: "medium",
        }),
      },
      {
        candidate: c,
        verdict: verdictFor(c, "UNSUPPORTED", ["protocol_not_x402"]),
        economicsV2: assessEconomicV2(
          c,
          verdictFor(c, "UNSUPPORTED", ["protocol_not_x402"]),
          { now: NOW },
        ),
      },
    ];

    const { decision, set } = runB6DecisionFromCandidates(rows, { now: NOW });
    expect(decision.decision).toBe("BUY");
    expect(decision.selectedCandidateId).toBe(a.candidate_id);
    expect(decision.payment_authorized).toBe(false);
    expect(decision.evaluatedCandidates.find((e) => e.candidateId === a.candidate_id)?.disposition).toBe(
      "SELECTED",
    );
    expect(decision.evaluatedCandidates.find((e) => e.candidateId === c.candidate_id)?.disposition).toBe(
      "UNSUPPORTED",
    );
    assertSelectionDecisionIntegrity(decision);
    assertDecisionBindsCandidateSet({
      candidateSetHash: decision.candidateSetHash,
      candidateObservationSetHash: decision.candidateObservationSetHash,
      set,
    });
    expect(decision.decisionPolicyHash).toBe(b6DecisionPolicyHash(B6_DECISION_POLICY_V1));
  });

  it("Case B: DEFER on material price rise without OBSERVED utility", () => {
    const a = candidateFromSynthetic({
      endpoint: SYNTHETIC_ALT_ENDPOINT,
      service_id: "rising_tip",
      amount_atomic: "1200",
      purpose: "tip",
      utility_confidence: "medium",
      utility_evidence: "advertised_tip",
    });
    const movement = buildPriceMovementEvidence({
      previous_amount_atomic: "1000",
      current_amount_atomic: "1200",
      classification: PRICE_CHANGE_REQUIRES_REEVALUATION,
    });
    expect(movement.relative_delta_bps).toBeGreaterThan(500);
    const v = verdictFor(a, "ELIGIBLE");
    const { decision } = runB6DecisionFromCandidates(
      [
        {
          candidate: a,
          verdict: v,
          economicsV2: assessEconomicV2(a, v, {
            now: NOW,
            priceMovementEvidence: movement,
            priorSuccessfulExecutionEvidence: false,
            priorDeliveredUtilityEvidence: false,
            utilityConfidenceOverride: "medium",
          }),
        },
      ],
      { now: NOW },
    );
    expect(decision.decision).toBe("DEFER");
    expect(decision.payment_authorized).toBe(false);
    expect(decision.deferralConditions?.some((d) => d.code === "PRICE_TOO_HIGH_RELATIVE_TO_RECENT_OBSERVATION")).toBe(
      true,
    );
  });

  it("Case C: DEFER incomplete utility on cheap eligible candidate", () => {
    const a = candidateFromSynthetic({
      endpoint: SYNTHETIC_ALT_ENDPOINT,
      service_id: "unknown_util",
      amount_atomic: "800",
      purpose: "unknown",
      utility_confidence: "none",
      utility_evidence: "unknown",
    });
    const v = verdictFor(a, "ELIGIBLE");
    const { decision } = runB6DecisionFromCandidates(
      [
        {
          candidate: a,
          verdict: v,
          economicsV2: assessEconomicV2(a, v, {
            now: NOW,
            priorSuccessfulExecutionEvidence: false,
            priorDeliveredUtilityEvidence: false,
            utilityConfidenceOverride: "none",
          }),
        },
      ],
      { now: NOW },
    );
    expect(decision.decision).toBe("DEFER");
    expect(decision.payment_authorized).toBe(false);
    expect(
      decision.deferralConditions?.some((d) => d.code === "UTILITY_EVIDENCE_INCOMPLETE"),
    ).toBe(true);
  });

  it("Case D: DONT_BUY when only ineligible candidates", () => {
    const a = candidateFromSynthetic({
      endpoint: "https://blocked.example.invalid/x",
      service_id: "blocked",
      amount_atomic: "1000",
      utility_confidence: "high",
    });
    const v = verdictFor(a, "INELIGIBLE", ["blocklist"]);
    const { decision } = runB6DecisionFromCandidates(
      [
        {
          candidate: a,
          verdict: v,
          economicsV2: assessEconomicV2(a, v, { now: NOW }),
        },
      ],
      { now: NOW },
    );
    expect(decision.decision).toBe("DONT_BUY");
    expect(decision.selectedCandidateId).toBeNull();
    expect(decision.payment_authorized).toBe(false);
    expect(decision.evaluatedCandidates[0]?.disposition).toBe("INELIGIBLE");
  });

  it("Case E: better candidate appears → old decision stale / reevaluate", () => {
    const a = candidateFromSynthetic({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "onesource_block_number",
      amount_atomic: "2000",
      utility_confidence: "medium",
      utility_evidence: "prior_trustforge_mainnet_payment_history_onesource_block_number",
    });
    const first = runB6DecisionFromCandidates(
      [
        {
          candidate: a,
          verdict: verdictFor(a, "ELIGIBLE"),
          economicsV2: assessEconomicV2(a, verdictFor(a, "ELIGIBLE"), {
            now: NOW,
            priorSuccessfulExecutionEvidence: true,
            utilityConfidenceOverride: "medium",
          }),
        },
      ],
      { now: NOW },
    );
    expect(first.decision.decision).toBe("BUY");

    const better = candidateFromSynthetic({
      endpoint: SYNTHETIC_ALT_ENDPOINT,
      service_id: "cheaper_block",
      amount_atomic: "500",
      pay_to: SYNTHETIC_PAY_TO_B,
      purpose: "block_number",
      utility_confidence: "medium",
      utility_evidence: "prior_successful",
      provider_id: "synthetic_better",
    });
    const second = runB6DecisionFromCandidates(
      [
        {
          candidate: a,
          verdict: verdictFor(a, "ELIGIBLE"),
          economicsV2: assessEconomicV2(a, verdictFor(a, "ELIGIBLE"), {
            now: NOW,
            priorSuccessfulExecutionEvidence: true,
            utilityConfidenceOverride: "medium",
          }),
        },
        {
          candidate: better,
          verdict: verdictFor(better, "ELIGIBLE"),
          economicsV2: assessEconomicV2(better, verdictFor(better, "ELIGIBLE"), {
            now: NOW,
            priorSuccessfulExecutionEvidence: true,
            utilityConfidenceOverride: "medium",
          }),
        },
      ],
      { now: NOW },
    );
    expect(second.decision.candidateSetHash).not.toBe(first.decision.candidateSetHash);
    expect(second.decision.selectionDecisionHash).not.toBe(
      first.decision.selectionDecisionHash,
    );
    expect(() =>
      assertDecisionBindsCandidateSet({
        candidateSetHash: first.decision.candidateSetHash,
        candidateObservationSetHash: first.decision.candidateObservationSetHash,
        set: second.set,
      }),
    ).toThrow(/BLOCKED_B6_SELECTION_SET_DRIFT|GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET/);
    // Old decision expires relative to far-future now
    expect(() =>
      assertSelectionDecisionFresh({
        decision: first.decision,
        now: new Date(NOW.getTime() + B6_DECISION_POLICY_V1.selection_ttl_ms + 1),
      }),
    ).toThrow(new RegExp(BLOCKED_B6_SELECTION_STALE));
  });

  it("Case F/G: live price movement vs intra-observation contradiction", () => {
    const live = classifyHistoricalVsLiveQuote({
      historical: { amount_atomic: "1000", asset: ASSET, pay_to: SYNTHETIC_PAY_TO_B, network: "eip155:8453" },
      live: { amount_atomic: "1200", asset: ASSET, pay_to: SYNTHETIC_PAY_TO_B, network: "eip155:8453" },
    });
    expect(live.classification).toBe(PRICE_CHANGE_REQUIRES_REEVALUATION);
    expect(live.accept_live_for_selection).toBe(true);

    const intra = classifyIntraObservationContradiction({
      amount_a: "1000",
      amount_b: "1200",
      same_observation: true,
    });
    expect(intra.classification).toBe(QUOTE_IDENTITY_CONTRADICTION);
    expect(intra.fail_closed).toBe(true);
  });

  it("post-human: approved 1000 vs paytime 1200 → BLOCKED_B52_FRESH_TERMS", () => {
    const syn = syntheticObservation({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "onesource_block_number",
      amount_atomic: "1000",
      purpose: "block_number",
    });
    expect(syn.selected).not.toBeNull();
    const intent = buildPaymentApprovalIntentFromSelected({
      selected: syn.selected!,
      advertisedPurpose: "block_number",
      whySelected: "B6 BUY synthetic",
    });
    expect(intent.amount_atomic).toBe("1000");
    expect(() =>
      assertFreshTermsWithinPaymentApprovalIntent({
        intent,
        fresh: {
          endpoint: intent.endpoint,
          method: intent.method,
          request_binding_sha256: intent.request_binding_sha256,
          network_canonical: intent.network_canonical,
          asset: intent.asset,
          amount_atomic: "1200",
          pay_to: intent.pay_to,
          scheme: intent.scheme,
          requirements_identity: intent.seller_requirements_identity,
        },
      }),
    ).toThrow(
      new RegExp(BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE),
    );
  });

  it("selection tamper fails closed", () => {
    const a = candidateFromSynthetic({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "onesource_block_number",
      amount_atomic: "1000",
      utility_confidence: "medium",
      utility_evidence: "prior_trustforge_mainnet_payment_history_onesource_block_number",
    });
    const { decision } = runB6DecisionFromCandidates(
      [
        {
          candidate: a,
          verdict: verdictFor(a, "ELIGIBLE"),
          economicsV2: assessEconomicV2(a, verdictFor(a, "ELIGIBLE"), {
            now: NOW,
            priorSuccessfulExecutionEvidence: true,
            utilityConfidenceOverride: "medium",
          }),
        },
      ],
      { now: NOW },
    );
    const tampered = {
      ...decision,
      selectedCandidateId: "0".repeat(64),
      selectionRationale: [{ code: "TAMPER", detail: "mutated" }],
    };
    expect(() => assertSelectionDecisionIntegrity(tampered)).toThrow(
      new RegExp(BLOCKED_B6_SELECTION_DECISION_TAMPER),
    );
    expect(paymentSelectionDecisionHash(tampered)).not.toBe(decision.selectionDecisionHash);
  });

  it("intent binds selection hash", () => {
    const syn = syntheticObservation({
      endpoint: SYNTHETIC_ONESOURCE_ENDPOINT,
      service_id: "onesource_block_number",
      amount_atomic: "1000",
      purpose: "block_number",
    });
    const candidate = normalizeRawPaymentCandidateObservation({
      ...syn.raw,
      purpose: "block_number",
    });
    const withUtil: PaymentCandidateV1 = {
      ...candidate,
      expected_utility: {
        purpose: "block_number",
        utility_confidence: "medium",
        evidence: "prior_trustforge_mainnet_payment_history_onesource_block_number",
      },
    };
    const { decision, set } = runB6DecisionFromCandidates(
      [
        {
          candidate: withUtil,
          verdict: verdictFor(withUtil, "ELIGIBLE"),
          economicsV2: assessEconomicV2(withUtil, verdictFor(withUtil, "ELIGIBLE"), {
            now: NOW,
            priorSuccessfulExecutionEvidence: true,
            utilityConfidenceOverride: "medium",
          }),
        },
      ],
      { now: NOW },
    );
    expect(decision.decision).toBe("BUY");
    const intent = buildPaymentApprovalIntentFromSelected({
      selected: syn.selected!,
      candidateId: decision.selectedCandidateId ?? undefined,
      selectionDecisionHash: decision.selectionDecisionHash,
      selectedCandidateId: decision.selectedCandidateId ?? undefined,
      selectedObservationId: decision.selectedObservationId ?? undefined,
      candidateSetHash: decision.candidateSetHash,
    });
    const bound = assertPaymentApprovalIntentBindsSelectionDecision(intent, decision);
    expect(bound.guard).toBe(GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION);
    const hashWith = paymentApprovalIntentHash(intent);
    const intentWrong = {
      ...intent,
      selection_decision_hash: "f".repeat(64),
    };
    expect(() =>
      assertPaymentApprovalIntentBindsSelectionDecision(intentWrong, decision),
    ).toThrow(new RegExp(GUARD_PAYMENT_APPROVAL_INTENT_BINDS_SELECTION_DECISION));
    // Selection fields participate in intent hash when present
    const intentNoSel = buildPaymentApprovalIntentFromSelected({
      selected: syn.selected!,
    });
    expect(paymentApprovalIntentHash(intentNoSel)).not.toBe(hashWith);
    void set;
  });

  it("B.6 guards present and DEFER/DONT_BUY do not imply payment auth", () => {
    assertB6HasNoExecutionAuthority();
    expect(GUARD_B6_CANNOT_SIGN).toBe("GUARD_B6_CANNOT_SIGN");
    expect(GUARD_B6_CANNOT_ACCESS_CREDENTIALS).toBe(
      "GUARD_B6_CANNOT_ACCESS_CREDENTIALS",
    );
    expect(GUARD_B6_CANNOT_CREATE_PAYMENT_HEADER).toBe(
      "GUARD_B6_CANNOT_CREATE_PAYMENT_HEADER",
    );
    expect(GUARD_B6_CANNOT_CREATE_PAYMENT_SEND_AUTHORIZATION).toBe(
      "GUARD_B6_CANNOT_CREATE_PAYMENT_SEND_AUTHORIZATION",
    );
    expect(GUARD_B6_CANNOT_CALL_PRODUCTIVE_PAYMENT_TRANSPORT).toBe(
      "GUARD_B6_CANNOT_CALL_PRODUCTIVE_PAYMENT_TRANSPORT",
    );
    expect(GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION).toBe(
      "GUARD_B6_BUY_IS_NOT_PAYMENT_AUTHORIZATION",
    );
    expect(GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET).toBe(
      "GUARD_SELECTION_DECISION_BINDS_CANDIDATE_SET",
    );
    expect(B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT).toBe(
      "B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT",
    );
    expect(B6_DECISION_POLICY_V1.payment_authorization).toBe(false);
  });
});
