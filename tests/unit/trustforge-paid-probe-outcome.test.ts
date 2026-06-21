import { describe, expect, it } from "vitest";

import {
  classifyPaidProbeOutcome,
  type PaidProbeOutcome,
} from "../../tools/trustforge/paid-probe-outcome";

describe("paid probe three-outcome model", () => {
  it("classifies on-chain settlement as PASS_SETTLED", () => {
    expect(
      classifyPaidProbeOutcome({
        paymentAttempted: true,
        onChainConfirmed: true,
        paymentBearingHttpRequestCount: 1,
        invariantsOk: true,
      }),
    ).toBe("PASS_SETTLED" satisfies PaidProbeOutcome);
  });

  it("classifies unpaid clean abort as PASS_NO_SETTLE_CLEAN", () => {
    expect(
      classifyPaidProbeOutcome({
        paymentAttempted: false,
        onChainConfirmed: false,
        paymentBearingHttpRequestCount: 0,
      }),
    ).toBe("PASS_NO_SETTLE_CLEAN");
  });

  it("classifies HTTP success or 402 without Transfer as FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN", () => {
    expect(
      classifyPaidProbeOutcome({
        paymentAttempted: true,
        onChainConfirmed: false,
        paymentBearingHttpRequestCount: 1,
        sellerHttpSuccessWithoutSettlement: true,
      }),
    ).toBe("FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN");
  });

  it("never maps RPC unavailable to settlement-not-found or no-settle-clean", () => {
    const outcome = classifyPaidProbeOutcome({
      paymentAttempted: false,
      onChainConfirmed: false,
      paymentBearingHttpRequestCount: 0,
      reconciliationUnavailable: true,
    });
    expect(outcome).toBe("BLOCKED_RECONCILIATION_UNAVAILABLE");
    expect(outcome).not.toBe("FAIL_SETTLEMENT_NOT_FOUND_ON_CHAIN");
    expect(outcome).not.toBe("PASS_NO_SETTLE_CLEAN");
  });
});
