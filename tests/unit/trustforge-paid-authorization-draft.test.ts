import { describe, expect, it } from "vitest";

import {
  assertDraftDecisionIsPending,
  buildHumanPaymentAuthorizationDraft,
  PENDING_HUMAN_DECISION,
} from "../../tools/run-trustforge-emit-paid-authorization-draft";
import type { DiscoveredSelectedCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";

const candidate: DiscoveredSelectedCandidate = {
  provider: "Zapper",
  service_id: "zapper_tx_explainer",
  endpoint: "https://public.zapper.xyz/x402/transaction-details",
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
    expect(draft.rationale).toBe("");
  });

  it("hard-fails when asked to emit a non-pending decision", () => {
    expect(() => assertDraftDecisionIsPending("authorize_one_payment")).toThrow(
      "BLOCKED_AUTHORIZATION_DRAFT_DECISION",
    );
  });
});
