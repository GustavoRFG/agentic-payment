import { describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  isMethodSupportedByThinRunner,
  probePaidMethodHonored,
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
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

function expectNoPaymentHeaders(headers: HeadersInit | undefined): void {
  expect(containsX402PaymentHeader(headers)).toBe(false);
  const normalized = new Headers(headers);
  expect(normalized.has("payment-signature")).toBe(false);
  expect(normalized.has("x-payment")).toBe(false);
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

  it("POST preserves endpoint and body, with zero payment headers", async () => {
    const endpoint = "https://seller.example/x402";
    const body = { tx: "0xabc", chain: "base" };
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toBe(endpoint);
      expect(init?.method).toBe(SETTLEMENT_PAID_HTTP_METHOD);
      expect(init?.body).toBe(JSON.stringify(body));
      expectNoPaymentHeaders(init?.headers);
      return new Response(paymentRequiredBody("1125"), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await probePaidMethodHonored({
      endpoint,
      method: "POST",
      body,
      fetchImpl,
    });
    expect(result.honored).toBe(true);
    expect(result.method).toBe("POST");
    expect(result.endpoint).toBe(endpoint);
    expect(result.httpStatus).toBe(402);
    expect(result.maxAmountRequiredAtomic).toBe("1125");
    expect(result.reason).toBeNull();
  });

  it("GET-only sends GET with query parameters and no body, then accepts HTTP 402", async () => {
    const endpoint = "https://get-only.example/x402";
    const fetchImpl = vi.fn(async (input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expectNoPaymentHeaders(init?.headers);
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(endpoint);
      expect(url.searchParams.get("tx")).toBe("0xabc");
      expect(url.searchParams.get("chain")).toBe("base");
      if (init?.method === "POST") return new Response("Method Not Allowed", { status: 405 });
      return new Response(paymentRequiredBody("1125"), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await probePaidMethodHonored({
      endpoint,
      method: "GET",
      body: { tx: "0xabc", chain: "base" },
      fetchImpl,
    });

    expect(result.honored).toBe(true);
    expect(result.method).toBe("GET");
    expect(result.httpStatus).toBe(402);
    expect(result.maxAmountRequiredAtomic).toBe("1125");
    expect(new URL(result.endpoint).searchParams.get("tx")).toBe("0xabc");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it.each(["PUT", "PATCH", "DELETE", "HEAD"])(
    "blocks unsupported %s before fetch",
    async (method) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const result = await probePaidMethodHonored({
        endpoint: "https://unsupported.example/x402",
        method,
        fetchImpl,
      });
      expect(result.honored).toBe(false);
      expect(result.reason).toContain(REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([404, 405, 501])("rejects HTTP %s as REJECTED_PAID_METHOD_NOT_HONORED", async (status) => {
    const endpoint = "https://seller.example/x402";
    const fetchImpl = vi.fn(async (_input, init) => {
      expectNoPaymentHeaders(init?.headers);
      return new Response("nope", { status });
    }) as unknown as typeof fetch;
    const result = await probePaidMethodHonored({ endpoint, fetchImpl });
    expect(result.honored).toBe(false);
    expect(result.httpStatus).toBe(status);
    expect(result.maxAmountRequiredAtomic).toBeNull();
    expect(result.reason).toBe(
      `${REJECTED_PAID_METHOD_NOT_HONORED}: settle POST ${endpoint} returned HTTP ${status}`,
    );
  });
});
