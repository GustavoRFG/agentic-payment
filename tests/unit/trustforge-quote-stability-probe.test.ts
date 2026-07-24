import { describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  evaluateQuoteStability,
  extractMaxAmountRequiredAtomic,
  probeQuoteStability,
  REJECTED_QUOTE_UNSTABLE,
} from "../../tools/trustforge/quote-stability-probe";

function paymentRequiredBody(amount: string): string {
  return JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: MAINNET_USDC_ADDRESS,
        maxAmountRequired: amount,
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 300,
      },
    ],
  });
}

describe("quote stability probe", () => {
  it("extracts maxAmountRequired atomic from a 402 body", () => {
    expect(
      extractMaxAmountRequiredAtomic({
        headers: {},
        body: JSON.parse(paymentRequiredBody("1125")),
      }),
    ).toBe("1125");
  });

  it("rejects divergence and zero quotes", () => {
    expect(evaluateQuoteStability("1125", "1125").stable).toBe(true);
    expect(evaluateQuoteStability("1125", "2000").stable).toBe(false);
    expect(evaluateQuoteStability("0", "0").stable).toBe(false);
    expect(evaluateQuoteStability("1125", "0").reason).toContain(REJECTED_QUOTE_UNSTABLE);
  });

  it("flags alternating second 402 maxAmountRequired as unstable", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      return new Response(paymentRequiredBody("2000"), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await probeQuoteStability({
      endpoint: "https://unstable.example/x402",
      firstMaxAmountRequiredAtomic: "1000",
      fetchImpl,
    });
    expect(result.stable).toBe(false);
    expect(result.reason).toBe(`${REJECTED_QUOTE_UNSTABLE}: first=1000 second=2000`);
    expect(result.evidence).toEqual({
      first_max_amount_required_atomic: "1000",
      second_max_amount_required_atomic: "2000",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
