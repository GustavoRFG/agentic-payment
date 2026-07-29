import { describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  isMethodSupportedByThinRunner,
  probePaidMethodHonored,
  REJECTED_PAID_METHOD_NOT_HONORED,
  SETTLEMENT_PAID_HTTP_METHOD,
} from "../../tools/trustforge/paid-method-honored-probe";

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

describe("paid method honored probe", () => {
  it.each(["POST", "GET"])("A.1 accepts the planner-supported %s method", (method) => {
    expect(isMethodSupportedByThinRunner(method)).toBe(true);
  });

  it.each(["PUT", "PATCH", "DELETE", "HEAD"])(
    "A.1 rejects the planner-unsupported %s method",
    (method) => {
      expect(isMethodSupportedByThinRunner(method)).toBe(false);
    },
  );

  it("accepts a keyless settle POST that returns 402 and extracts maxAmountRequired", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.method).toBe(SETTLEMENT_PAID_HTTP_METHOD);
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      return new Response(paymentRequiredBody("1125"), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await probePaidMethodHonored({
      endpoint: "https://seller.example/x402",
      fetchImpl,
    });
    expect(result.honored).toBe(true);
    expect(result.httpStatus).toBe(402);
    expect(result.maxAmountRequiredAtomic).toBe("1125");
    expect(result.reason).toBeNull();
  });

  it.each([404, 405, 501])("rejects HTTP %s as REJECTED_PAID_METHOD_NOT_HONORED", async (status) => {
    const endpoint = "https://seller.example/x402";
    const fetchImpl = vi.fn(async () => new Response("nope", { status })) as unknown as typeof fetch;
    const result = await probePaidMethodHonored({ endpoint, fetchImpl });
    expect(result.honored).toBe(false);
    expect(result.httpStatus).toBe(status);
    expect(result.maxAmountRequiredAtomic).toBeNull();
    expect(result.reason).toBe(
      `${REJECTED_PAID_METHOD_NOT_HONORED}: settle POST ${endpoint} returned HTTP ${status}`,
    );
  });
});
