import { describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import {
  probePaidMethodHonored,
  REJECTED_PAID_METHOD_NOT_HONORED,
  SETTLEMENT_PAID_HTTP_METHOD,
} from "../../tools/trustforge/paid-method-honored-probe";

describe("paid method honored probe", () => {
  it("accepts a keyless settle POST that returns 402", async () => {
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.method).toBe(SETTLEMENT_PAID_HTTP_METHOD);
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      return new Response("{}", { status: 402 });
    }) as unknown as typeof fetch;

    const result = await probePaidMethodHonored({
      endpoint: "https://seller.example/x402",
      fetchImpl,
    });
    expect(result.honored).toBe(true);
    expect(result.httpStatus).toBe(402);
    expect(result.reason).toBeNull();
  });

  it.each([404, 405, 501])("rejects HTTP %s as REJECTED_PAID_METHOD_NOT_HONORED", async (status) => {
    const endpoint = "https://seller.example/x402";
    const fetchImpl = vi.fn(async () => new Response("nope", { status })) as unknown as typeof fetch;
    const result = await probePaidMethodHonored({ endpoint, fetchImpl });
    expect(result.honored).toBe(false);
    expect(result.httpStatus).toBe(status);
    expect(result.reason).toBe(
      `${REJECTED_PAID_METHOD_NOT_HONORED}: settle POST ${endpoint} returned HTTP ${status}`,
    );
  });
});
