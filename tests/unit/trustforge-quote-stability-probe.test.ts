import { describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  evaluateQuoteStability,
  extractMaxAmountRequiredAtomic,
  probeQuoteStability,
  REJECTED_QUOTE_EXTRACTION_FAILED,
  REJECTED_QUOTE_UNSTABLE,
} from "../../tools/trustforge/quote-stability-probe";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";

function postBinding(endpoint: string) {
  return createThinSettlementRequestBinding({
    endpoint,
    method: "POST",
    input_status: "known",
    query: [],
    body: {},
  });
}

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

  it("classifies equality independently from quote acceptability", () => {
    expect(evaluateQuoteStability("1000", "1000")).toMatchObject({ stable: true, reason: null });
    expect(evaluateQuoteStability("0", "0")).toMatchObject({ stable: true, reason: null });

    const divergent = evaluateQuoteStability("0", "1000");
    expect(divergent.stable).toBe(false);
    expect(divergent.reason).toBe(`${REJECTED_QUOTE_UNSTABLE}: first=0 second=1000`);
  });

  it("classifies missing or invalid atomic values as extraction failure", () => {
    for (const [first, second] of [
      [null, null],
      ["1000", null],
      ["-1", "-1"],
      ["1.5", "1.5"],
    ] as const) {
      const result = evaluateQuoteStability(first, second);
      expect(result.stable).toBe(false);
      expect(result.reason).toContain(REJECTED_QUOTE_EXTRACTION_FAILED);
      expect(result.reason).not.toContain(REJECTED_QUOTE_UNSTABLE);
    }
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
      requestBinding: postBinding("https://unstable.example/x402"),
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

  it("reports second-402 amount absence as extraction failure, not instability", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      return new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              asset: MAINNET_USDC_ADDRESS,
              payTo: "0x1111111111111111111111111111111111111111",
            },
          ],
        }),
        { status: 402, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await probeQuoteStability({
      requestBinding: postBinding("https://missing-quote.example/x402"),
      firstMaxAmountRequiredAtomic: "1000",
      fetchImpl,
    });

    expect(result.stable).toBe(false);
    expect(result.reason).toContain(REJECTED_QUOTE_EXTRACTION_FAILED);
    expect(result.reason).not.toContain(REJECTED_QUOTE_UNSTABLE);
    expect(result.evidence).toEqual({
      first_max_amount_required_atomic: "1000",
      second_max_amount_required_atomic: null,
    });
    expect(result.httpStatus).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
