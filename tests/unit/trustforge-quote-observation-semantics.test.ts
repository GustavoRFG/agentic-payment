/**
 * Quote observation semantics — price movement vs identity contradiction.
 * NO PAYMENT.
 */

import { describe, expect, it } from "vitest";

import {
  buildPriceMovementEvidence,
  classifyHistoricalVsLiveQuote,
  classifyIntraObservationContradiction,
  LIVE_PRICE_MOVEMENT_OBSERVED,
  PRICE_CHANGE_REQUIRES_REEVALUATION,
  QUOTE_IDENTITY_CONTRADICTION,
  QUOTE_UNREADABLE_OR_MALFORMED,
} from "../../tools/trustforge/quote-observation-semantics";

const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const PAY_TO = "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea";

describe("quote observation semantics", () => {
  it("Case F: live 1000→1200 is PRICE_CHANGE_REQUIRES_REEVALUATION, not contradiction", () => {
    const result = classifyHistoricalVsLiveQuote({
      historical: {
        amount_atomic: "1000",
        asset: ASSET,
        pay_to: PAY_TO,
        network: "eip155:8453",
      },
      live: {
        amount_atomic: "1200",
        asset: ASSET,
        pay_to: PAY_TO,
        network: "eip155:8453",
      },
    });
    expect(result.classification).toBe(PRICE_CHANGE_REQUIRES_REEVALUATION);
    expect(result.accept_live_for_selection).toBe(true);
    expect(result.reason).toContain(LIVE_PRICE_MOVEMENT_OBSERVED);

    const evidence = buildPriceMovementEvidence({
      previous_amount_atomic: "1000",
      current_amount_atomic: "1200",
      classification: result.classification,
    });
    expect(evidence.price_direction).toBe("up");
    expect(evidence.relative_delta_bps).toBe(2000);
    expect(evidence.absolute_delta_atomic).toBe("200");
  });

  it("Case G: intra-observation 1000+1200 is QUOTE_IDENTITY_CONTRADICTION", () => {
    const result = classifyIntraObservationContradiction({
      amount_a: "1000",
      amount_b: "1200",
      same_observation: true,
    });
    expect(result.classification).toBe(QUOTE_IDENTITY_CONTRADICTION);
    expect(result.fail_closed).toBe(true);
  });

  it("fail-closes on asset/payTo/network identity mismatch", () => {
    const assetMismatch = classifyHistoricalVsLiveQuote({
      historical: {
        amount_atomic: "1000",
        asset: ASSET,
        pay_to: PAY_TO,
        network: "eip155:8453",
      },
      live: {
        amount_atomic: "1000",
        asset: "0x0000000000000000000000000000000000000001",
        pay_to: PAY_TO,
        network: "eip155:8453",
      },
    });
    expect(assetMismatch.classification).toBe(QUOTE_IDENTITY_CONTRADICTION);
    expect(assetMismatch.accept_live_for_selection).toBe(false);
  });

  it("treats unreadable live amount as malformed", () => {
    const result = classifyHistoricalVsLiveQuote({
      historical: { amount_atomic: "1000", asset: ASSET },
      live: { amount_atomic: null, asset: ASSET },
    });
    expect(result.classification).toBe(QUOTE_UNREADABLE_OR_MALFORMED);
    expect(result.accept_live_for_selection).toBe(false);
  });
});
