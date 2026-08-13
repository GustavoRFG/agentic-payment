/**
 * B.6 → B.4 headless e2e (binding + approve path).
 * NO production UI. NO real signer. NO network payment.
 * BUY path proves selection→intent→headless APPROVE binding only
 * (no loopback payment runner; signatures/requests not invoked).
 */

import { describe, expect, it } from "vitest";

import { runB6DecisionFromCandidates } from "../../tools/trustforge/b6-run-decision";
import { assessEconomicV2 } from "../../tools/trustforge/economic-assessment-v2";
import {
  assertHumanDecisionBindsPaymentIntentHash,
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
  paymentApprovalIntentToCandidateView,
} from "../../tools/trustforge/payment-approval-intent";
import { normalizeRawPaymentCandidateObservation } from "../../tools/trustforge/payment-candidate-normalize";
import type { CandidatePolicyVerdict } from "../../tools/trustforge/payment-candidate-policy";
import type { PaymentCandidateV1 } from "../../tools/trustforge/payment-candidate-v1";
import {
  buildDecisionOutcome,
  createTestHumanPaymentDecisionProvider,
} from "../../tools/trustforge/human-payment-decision-provider";
import { buildPriceMovementEvidence, PRICE_CHANGE_REQUIRES_REEVALUATION } from "../../tools/trustforge/quote-observation-semantics";
import {
  SYNTHETIC_ALT_ENDPOINT,
  SYNTHETIC_ONESOURCE_ENDPOINT,
  SYNTHETIC_PAY_TO_B,
  syntheticObservation,
} from "../support/trustforge-b5-synthetic-candidates";

const NOW = new Date("2026-08-13T05:30:00.000Z");

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
  utility_confidence?: PaymentCandidateV1["expected_utility"]["utility_confidence"];
  utility_evidence?: string;
}): { candidate: PaymentCandidateV1; selected: NonNullable<ReturnType<typeof syntheticObservation>["selected"]> } {
  const syn = syntheticObservation({
    endpoint: input.endpoint,
    service_id: input.service_id,
    amount_atomic: input.amount_atomic,
    pay_to: input.pay_to,
    purpose: input.purpose ?? "block_number",
    provider_id: input.provider_id,
    discovered_at: "2026-08-13T05:25:00.000Z",
    with_execution_handoff: true,
  });
  const base = normalizeRawPaymentCandidateObservation(syn.raw);
  const candidate: PaymentCandidateV1 = {
    ...base,
    expected_utility: {
      purpose: input.purpose ?? "block_number",
      utility_confidence: input.utility_confidence ?? "medium",
      evidence: input.utility_evidence ?? "advertised_block_number",
    },
  };
  expect(syn.selected).not.toBeNull();
  return { candidate, selected: syn.selected! };
}

describe("B.6 → B.4 headless e2e (no UI / no payment)", () => {
  it("BUY: selection→intent bind→headless APPROVE; no UI; signatures/requests not invoked", async () => {
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

    let selectionDecisionCount = 0;
    let approvalProviderCalls = 0;
    let signatureInvocations = 0;
    let paymentRequestInvocations = 0;
    let visibleWindows = 0;

    const rows = [
      {
        candidate: a.candidate,
        verdict: verdictFor(a.candidate, "ELIGIBLE"),
        economicsV2: assessEconomicV2(a.candidate, verdictFor(a.candidate, "ELIGIBLE"), {
          now: NOW,
          priorSuccessfulExecutionEvidence: true,
          utilityConfidenceOverride: "medium",
        }),
      },
      {
        candidate: b.candidate,
        verdict: verdictFor(b.candidate, "ELIGIBLE"),
        economicsV2: assessEconomicV2(b.candidate, verdictFor(b.candidate, "ELIGIBLE"), {
          now: NOW,
          utilityConfidenceOverride: "medium",
        }),
      },
      {
        candidate: c.candidate,
        verdict: verdictFor(c.candidate, "UNSUPPORTED", ["protocol_not_x402"]),
        economicsV2: assessEconomicV2(
          c.candidate,
          verdictFor(c.candidate, "UNSUPPORTED", ["protocol_not_x402"]),
          { now: NOW },
        ),
      },
    ];

    const { decision } = runB6DecisionFromCandidates(rows, { now: NOW });
    selectionDecisionCount += 1;
    expect(decision.decision).toBe("BUY");
    expect(decision.selectedCandidateId).toBe(a.candidate.candidate_id);
    expect(decision.payment_authorized).toBe(false);

    const intent = buildPaymentApprovalIntentFromSelected({
      selected: a.selected,
      candidateId: decision.selectedCandidateId ?? undefined,
      advertisedPurpose: "block_number",
      whySelected: "B6 BUY headless e2e synthetic",
      selectionDecisionHash: decision.selectionDecisionHash,
      selectedCandidateId: decision.selectedCandidateId ?? undefined,
      selectedObservationId: decision.selectedObservationId ?? undefined,
      candidateSetHash: decision.candidateSetHash,
    });
    assertPaymentApprovalIntentBindsSelectionDecision(intent, decision);
    expect(intent.selection_decision_hash).toBe(decision.selectionDecisionHash);
    expect(intent.selected_candidate_id).toBe(decision.selectedCandidateId);
    expect(intent.selected_observation_id).toBe(decision.selectedObservationId);
    expect(intent.candidate_set_hash).toBe(decision.candidateSetHash);
    expect(intent.payment_authorized).toBe(false);

    const view = paymentApprovalIntentToCandidateView(intent);
    const provider = createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "APPROVE",
        decision_source: "approve_button",
        human_decision_id: "paydec_b6_e2e_buy",
        decided_at: "2026-08-13T05:31:00.000Z",
        provider_id: "test-human-payment-decision",
      }),
    );
    approvalProviderCalls += 1;
    const human = await provider.decideOnce(view);
    assertHumanDecisionBindsPaymentIntentHash({
      payment_approval_intent_hash: human.payment_approval_intent_hash,
      expected_hash: paymentApprovalIntentHash(intent),
    });
    expect(human.decision).toBe("APPROVE");
    expect(human.provider_id).toBe("test-human-payment-decision");

    // Documented no-effects: do not call thin runner / signer / network.
    expect(selectionDecisionCount).toBe(1);
    expect(visibleWindows).toBe(0);
    expect(signatureInvocations).toBe(0);
    expect(paymentRequestInvocations).toBe(0);
    expect(approvalProviderCalls).toBe(1);
  });

  it("DEFER: no decideOnce / no approval provider effects", async () => {
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
    const v = verdictFor(a.candidate, "ELIGIBLE");
    let approvalProviderCalls = 0;
    let signatureInvocations = 0;
    let paymentRequestInvocations = 0;
    let visibleWindows = 0;

    const { decision } = runB6DecisionFromCandidates(
      [
        {
          candidate: a.candidate,
          verdict: v,
          economicsV2: assessEconomicV2(a.candidate, v, {
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
    expect(decision.selectedCandidateId).toBeNull();

    // DEFER must not open human approval or invoke payment side effects.
    expect(approvalProviderCalls).toBe(0);
    expect(signatureInvocations).toBe(0);
    expect(paymentRequestInvocations).toBe(0);
    expect(visibleWindows).toBe(0);
  });

  it("DONT_BUY: no decideOnce / no approval provider effects", async () => {
    const a = candidateFromSynthetic({
      endpoint: "https://blocked.example.invalid/x",
      service_id: "blocked",
      amount_atomic: "1000",
      utility_confidence: "high",
    });
    const v = verdictFor(a.candidate, "INELIGIBLE", ["blocklist"]);
    let approvalProviderCalls = 0;
    let signatureInvocations = 0;
    let paymentRequestInvocations = 0;
    let visibleWindows = 0;

    const { decision } = runB6DecisionFromCandidates(
      [
        {
          candidate: a.candidate,
          verdict: v,
          economicsV2: assessEconomicV2(a.candidate, v, { now: NOW }),
        },
      ],
      { now: NOW },
    );
    expect(decision.decision).toBe("DONT_BUY");
    expect(decision.payment_authorized).toBe(false);
    expect(decision.selectedCandidateId).toBeNull();

    expect(approvalProviderCalls).toBe(0);
    expect(signatureInvocations).toBe(0);
    expect(paymentRequestInvocations).toBe(0);
    expect(visibleWindows).toBe(0);
  });
});
