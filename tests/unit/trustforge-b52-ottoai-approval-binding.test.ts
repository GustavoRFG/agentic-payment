/**
 * B.5.2 OttoAI approval-binding gate — headless only.
 * NO production UI. NO signer. NO payment.
 */

import { describe, expect, it } from "vitest";

import {
  BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE,
  B52_APPROVAL_BINDING_READY,
  CANDIDATE_AUTHORIZATION_REQUEST_TRIPLE_BINDING,
  GUARD_HUMAN_DECISION_BINDS_PAYMENT_INTENT_HASH,
  GUARD_METHOD_BINDING_CANDIDATE_AUTHORIZATION_REQUEST,
  GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT,
} from "../../tools/trustforge/b52-execution-gates";
import {
  assertFreshTermsWithinPaymentApprovalIntent,
  assertHumanDecisionBindsPaymentIntentHash,
  assertHumanDisplayBindsPaymentApprovalIntent,
  assertJitAuthoritySubsetOfPaymentApprovalIntent,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
  paymentApprovalIntentToCandidateView,
  proveCandidateAuthorizationRequestTripleBinding,
  proveMethodBindingNominalGet,
  type PaymentApprovalIntent,
} from "../../tools/trustforge/payment-approval-intent";
import {
  createTestHumanPaymentDecisionProvider,
  buildDecisionOutcome,
} from "../../tools/trustforge/human-payment-decision-provider";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import type { DiscoveredSelectedCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";

const BUYER = "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1";
const PAY_TO = "0x0E84dDEdAaE6A779c462C22a59F301EC31B6b808";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ENDPOINT = "https://x402.ottoai.services/crypto-news";
const REQ_HASH = "34d37959a3f37cfcc3a2d5d7f6d7d28cdbfebf5c0f930c01a7092200e9bf9e82";

function syntheticObservation(endpoint: string): SellerRequirementsObservation {
  const rb = createThinSettlementRequestBinding({
    endpoint,
    method: "GET",
    input_status: "known",
    query: [],
    body: null,
  });
  const selected = {
    scheme: "exact",
    network: "eip155:8453",
    asset: ASSET,
    amount: "1000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
  };
  const envelope = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: endpoint, description: "crypto news" },
    accepts: [selected],
  };
  return {
    requirements_observed_at: "2026-08-13T06:00:00.000Z",
    selected_requirements: selected,
    payment_required_envelope: envelope,
    binding: {
      protocol_version: 2,
      transport: "payment-required-header",
      scheme: "exact",
      seller_network_raw: "eip155:8453",
      canonical_network_caip2: "eip155:8453",
      asset: ASSET,
      amount_atomic: "1000",
      amount_field: "amount",
      pay_to: PAY_TO,
      max_timeout_seconds: 300,
      resource: envelope.resource,
      extra: selected.extra,
      request_binding_sha256: rb.binding_sha256,
      canonical_requirements_sha256: REQ_HASH,
      canonical_envelope_sha256: "a".repeat(64),
    },
    ancillary_tempo_evidence: null,
  };
}

function ottoSelected(): DiscoveredSelectedCandidate {
  const endpoint = ENDPOINT;
  const rb = createThinSettlementRequestBinding({
    endpoint,
    method: "GET",
    input_status: "known",
    query: [],
    body: null,
  });
  const obs = syntheticObservation(endpoint);
  return {
    schema_version: "trustforge_selected_candidate.v3",
    provider: "bazaar_unpaid",
    service_id: "x402_ottoai_services_crypto_news_b52",
    endpoint,
    method: "GET",
    request_input_status: "known",
    request_query: [],
    request_body: null,
    request_input_provenance: "policy_generated_request_binding",
    request_binding_sha256: rb.binding_sha256,
    protocol_version: 2,
    transport: "payment-required-header",
    scheme: "exact",
    amount_field: "amount",
    max_timeout_seconds: 300,
    resource: { url: endpoint },
    extra: { name: "USD Coin", version: "2" },
    canonical_requirements_sha256: REQ_HASH,
    canonical_envelope_sha256: "a".repeat(64),
    selection_requirements_observed_at: obs.requirements_observed_at,
    ancillary_tempo_evidence: null,
    seller_requirements: obs,
    quote_amount_usdc: "0.001",
    quote_atomic: "1000",
    authorized_pay_to: PAY_TO,
    recommended_max_usdc: "0.005",
    seller_network_raw: "eip155:8453",
    canonical_network_caip2: "eip155:8453",
    network: "eip155:8453",
    asset: ASSET,
    buyer_wallet: BUYER,
    target_selection_audit: {
      selected_resource_url: endpoint,
      handshake_status: "live_402_ok",
      fallback_resource_urls: [],
      scoring_rationale: ["b52_test"],
    },
    selected_at_utc: "2026-08-13T06:00:00.000Z",
  };
}

function ottoIntent(): PaymentApprovalIntent {
  return buildPaymentApprovalIntentFromSelected({
    selected: ottoSelected(),
    serviceLabel: "OttoAI - Crypto News",
    advertisedPurpose:
      "Real-time crypto news with sentiment and ranked headlines",
    purposeEvidenceClass:
      "Advertised purpose confirmed; delivered content quality not yet verified.",
    whySelected:
      "First materially distinct second seller for the B5 generalized payment path.",
    knownFacts: ["fresh unpaid 402 observed", "x402 v2 / exact", "Base + USDC"],
    unknownFacts: ["paid response schema/quality"],
  });
}

describe("B.5.2 PaymentApprovalIntent binding (headless)", () => {
  it("hashes intent stably and projects authoritative UI view", () => {
    const intent = ottoIntent();
    const h1 = paymentApprovalIntentHash(intent);
    const h2 = paymentApprovalIntentHash(intent);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);

    const view = paymentApprovalIntentToCandidateView(intent);
    expect(view.ui_source).toBe("authoritative_PaymentApprovalIntent");
    expect(view.payment_approval_intent_hash).toBe(h1);
    expect(view.method).toBe("GET");
    expect(view.endpoint).toBe(ENDPOINT);
    expect(view.seller).toBe(PAY_TO);
    expect(view.amount_usdc).toBe("0.001");

    const display = assertHumanDisplayBindsPaymentApprovalIntent({
      intent,
      displayed: {
        service: view.service_label,
        endpoint: view.endpoint,
        method: view.method,
        request: view.request_summary,
        network: "Base",
        asset: "USDC",
        amount: view.amount_usdc,
        pay_to: view.seller,
      },
    });
    expect(display.guard).toBe(GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT);
  });

  it("binds human decision to paymentApprovalIntentHash", async () => {
    const intent = ottoIntent();
    const view = paymentApprovalIntentToCandidateView(intent);
    const provider = createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "APPROVE",
        decision_source: "approve_button",
        human_decision_id: "paydec_test",
        decided_at: "2026-08-13T06:01:00.000Z",
        provider_id: "test-human-payment-decision",
      }),
    );
    const decision = await provider.decideOnce(view);
    expect(decision.payment_approval_intent_hash).toBe(view.payment_approval_intent_hash);
    assertHumanDecisionBindsPaymentIntentHash({
      payment_approval_intent_hash: decision.payment_approval_intent_hash,
      expected_hash: paymentApprovalIntentHash(intent),
    });
    expect(GUARD_HUMAN_DECISION_BINDS_PAYMENT_INTENT_HASH).toBeTruthy();
  });

  it("proves nominal GET method binding across the full chain", () => {
    const proof = proveMethodBindingNominalGet({
      normalizedCandidateMethod: "GET",
      selectedCandidateMethod: "GET",
      paymentApprovalIntentMethod: "GET",
      humanDecisionBoundMethod: "GET",
      buyerSigningAuthorizationMethod: "GET",
      paymentSendAuthorizationMethod: "GET",
      productiveHttpRequestMethod: "GET",
    });
    expect(proof.status).toBe("PASS");
    expect(proof.all_equal_get).toBe(true);
    expect(proof.guard).toBe(GUARD_METHOD_BINDING_CANDIDATE_AUTHORIZATION_REQUEST);
  });

  it("GET→POST negative: blocks before signer/send", () => {
    const proof = proveMethodBindingNominalGet({
      normalizedCandidateMethod: "GET",
      selectedCandidateMethod: "GET",
      paymentApprovalIntentMethod: "GET",
      humanDecisionBoundMethod: "GET",
      buyerSigningAuthorizationMethod: "GET",
      paymentSendAuthorizationMethod: "GET",
      productiveHttpRequestMethod: "POST",
    });
    expect(proof.status).toBe("FAIL");
    expect(proof.reasons.join(" ")).toMatch(/POST|planned|mismatch/i);
  });

  it("candidate GET + auth GET + request POST fails closed", () => {
    const proof = proveMethodBindingNominalGet({
      normalizedCandidateMethod: "GET",
      selectedCandidateMethod: "GET",
      paymentApprovalIntentMethod: "GET",
      humanDecisionBoundMethod: "GET",
      buyerSigningAuthorizationMethod: "GET",
      paymentSendAuthorizationMethod: "GET",
      productiveHttpRequestMethod: "POST",
    });
    expect(proof.status).toBe("FAIL");
  });

  it("authorization GET vs candidate POST blocks", () => {
    const proof = proveMethodBindingNominalGet({
      normalizedCandidateMethod: "GET",
      selectedCandidateMethod: "GET",
      paymentApprovalIntentMethod: "GET",
      humanDecisionBoundMethod: "GET",
      buyerSigningAuthorizationMethod: "POST",
      paymentSendAuthorizationMethod: "POST",
      productiveHttpRequestMethod: "GET",
    });
    expect(proof.status).toBe("FAIL");
  });

  it("triple request binding PASS for identical GET identities", () => {
    const id = createThinSettlementRequestBinding({
      endpoint: ENDPOINT,
      method: "GET",
      input_status: "known",
      query: [],
      body: null,
    }).binding_sha256;
    const triple = proveCandidateAuthorizationRequestTripleBinding({
      authorizationRequestIdentity: id,
      selectedCandidateRequestIdentity: id,
      actualRequestIdentity: id,
      method: "GET",
    });
    expect(triple.result).toBe(`${CANDIDATE_AUTHORIZATION_REQUEST_TRIPLE_BINDING}: PASS`);
  });

  it("JIT authority subset: economic equality; amount change blocks", () => {
    const intent = ottoIntent();
    const rb = intent.request_binding_sha256;
    const ok = assertJitAuthoritySubsetOfPaymentApprovalIntent({
      intent,
      jit: {
        endpoint: intent.endpoint,
        method: intent.method,
        request_binding_sha256: rb,
        buyer: intent.buyer,
        network_canonical: intent.network_canonical,
        asset: intent.asset,
        amount_atomic: intent.amount_atomic,
        pay_to: intent.pay_to,
        scheme: intent.scheme,
      },
      fresh_requirements_identity: intent.seller_requirements_identity,
      fresh_envelope_identity: "b".repeat(64),
    });
    expect(ok.ok).toBe(true);
    expect(ok.envelope_rotation_allowed).toBe(true);

    expect(() =>
      assertFreshTermsWithinPaymentApprovalIntent({
        intent,
        fresh: {
          endpoint: intent.endpoint,
          method: intent.method,
          request_binding_sha256: rb,
          network_canonical: intent.network_canonical,
          asset: intent.asset,
          amount_atomic: "2000",
          pay_to: intent.pay_to,
          scheme: intent.scheme,
          requirements_identity: intent.seller_requirements_identity,
        },
      }),
    ).toThrow(BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE);

    expect(() =>
      assertFreshTermsWithinPaymentApprovalIntent({
        intent,
        fresh: {
          endpoint: intent.endpoint,
          method: "POST",
          request_binding_sha256: rb,
          network_canonical: intent.network_canonical,
          asset: intent.asset,
          amount_atomic: intent.amount_atomic,
          pay_to: intent.pay_to,
          scheme: intent.scheme,
          requirements_identity: intent.seller_requirements_identity,
        },
      }),
    ).toThrow(BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE);
  });

  it("records B52_APPROVAL_BINDING_READY checklist constants", () => {
    expect(B52_APPROVAL_BINDING_READY).toBe("B52_APPROVAL_BINDING_READY");
  });
});
