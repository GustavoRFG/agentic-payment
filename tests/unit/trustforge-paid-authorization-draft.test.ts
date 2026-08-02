import { describe, expect, it } from "vitest";

import {
  assertDraftDecisionIsPending,
  buildHumanPaymentAuthorizationDraft,
  PENDING_HUMAN_DECISION,
} from "../../tools/run-trustforge-emit-paid-authorization-draft";
import type { DiscoveredSelectedCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
} from "../../tools/trustforge/thin-settlement-request-binding";

const REQUEST_BINDING = createThinSettlementRequestBinding({
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
  method: "POST",
  input_status: "known",
  query: [],
  body: { hash: "0xabc", chainId: 1 },
});

const candidate: DiscoveredSelectedCandidate = {
  provider: "Zapper",
  service_id: "zapper_tx_explainer",
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
  method: "POST",
  request_input_status: "known",
  request_query: REQUEST_BINDING.query,
  request_body: REQUEST_BINDING.body,
  request_input_provenance: "bazaar.extensions.bazaar.info.input",
  request_binding_sha256: REQUEST_BINDING.binding_sha256,
  quote_amount_usdc: "0.001125",
  quote_atomic: "1125",
  authorized_pay_to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
  recommended_max_usdc: "0.002125",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  buyer_wallet: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
  target_selection_audit: {
    selected_resource_url: "https://public.zapper.xyz/x402/transaction-details",
    handshake_status: "live_402_ok",
    fallback_resource_urls: [],
    scoring_rationale: ["price_atomic=1125"],
  },
  selected_at_utc: "2026-06-20T00:00:00.000Z",
};

describe("human payment authorization DRAFT generator", () => {
  it("writes a PENDING_HUMAN draft with single-shot constraints", () => {
    const draft = buildHumanPaymentAuthorizationDraft(candidate);
    expect(draft.decision).toBe(PENDING_HUMAN_DECISION);
    expect(draft.max_payment_attempts).toBe(1);
    expect(draft.allow_retry).toBe(false);
    expect(draft.require_dedicated_wallet).toBe(true);
    expect(draft.max_usdc).toBe("0.002125");
    expect(draft.target_selection_audit).toEqual(candidate.target_selection_audit);
    expect(draft.request_binding_sha256).toBe(REQUEST_BINDING.binding_sha256);
    expect(draft.request_summary).toEqual(thinSettlementRequestSummary(REQUEST_BINDING));
    expect(draft.rationale).toBe("");
  });

  it("carries the candidate's explicit POST method", () => {
    const draft = buildHumanPaymentAuthorizationDraft(candidate);
    expect(draft.method).toBe("POST");
  });

  it("copies a GET query binding into the human-auditable summary", () => {
    const getBinding = createThinSettlementRequestBinding({
      endpoint: "https://api.onesource.io/api/chain/network-info",
      method: "GET",
      input_status: "known",
      query: { network: "ethereum" },
      body: null,
    });
    const draft = buildHumanPaymentAuthorizationDraft({
      ...candidate,
      endpoint: getBinding.endpoint,
      method: "GET",
      request_query: getBinding.query,
      request_body: getBinding.body,
      request_binding_sha256: getBinding.binding_sha256,
      target_selection_audit: {
        ...candidate.target_selection_audit,
        selected_resource_url: getBinding.endpoint,
      },
    });
    expect(draft.method).toBe("GET");
    expect(draft.request_summary.query).toEqual([["network", "ethereum"]]);
    expect(draft.request_summary.body).toBeNull();
  });

  it("fails closed when the candidate declares no method", () => {
    const { method: _absent, ...withoutMethod } = candidate;
    expect(() =>
      buildHumanPaymentAuthorizationDraft(withoutMethod as DiscoveredSelectedCandidate),
    ).toThrow("REJECTED_REQUEST_BINDING_INVALID");
  });

  it("hard-fails when asked to emit a non-pending decision", () => {
    expect(() => assertDraftDecisionIsPending("authorize_one_payment")).toThrow(
      "BLOCKED_AUTHORIZATION_DRAFT_DECISION",
    );
  });
});
