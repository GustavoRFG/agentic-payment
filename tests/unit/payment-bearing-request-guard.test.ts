import { afterEach, describe, expect, it, vi } from "vitest";

import {
  containsX402PaymentHeader,
  createPaymentBearingRequestGuard,
} from "../../buyer-client/src/payment-bearing-request-guard";
import { MAX_PAYMENT_ATTEMPTS } from "../../shared/payment-safety";

// Synthetic, non-secret placeholder. Never a real signature/authorization value.
const SYNTHETIC_PAYMENT_VALUE = "SYNTHETIC-NOT-A-REAL-SIGNATURE";

describe("payment-bearing request guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not increment the counter for a request without a payment header", () => {
    const guard = createPaymentBearingRequestGuard();

    guard.inspect({ "Content-Type": "application/json" });
    guard.inspect(new Headers({ "X-Agentic-Request-Id": "abc" }));
    guard.inspect(undefined);

    expect(guard.getPaymentBearingRequests()).toBe(0);
  });

  it("allows the first payment-bearing request", () => {
    const guard = createPaymentBearingRequestGuard();

    expect(() =>
      guard.inspect({ "PAYMENT-SIGNATURE": SYNTHETIC_PAYMENT_VALUE }),
    ).not.toThrow();
    expect(guard.getPaymentBearingRequests()).toBe(1);
  });

  it("throws on the second payment-bearing request", () => {
    const guard = createPaymentBearingRequestGuard();

    guard.inspect({ "PAYMENT-SIGNATURE": SYNTHETIC_PAYMENT_VALUE });

    expect(() =>
      guard.inspect({ "X-PAYMENT": SYNTHETIC_PAYMENT_VALUE }),
    ).toThrow("refusing more than one payment-bearing HTTP request");
    expect(guard.getPaymentBearingRequests()).toBe(2);
  });

  it("matches the payment header name case-insensitively", () => {
    expect(
      containsX402PaymentHeader({ "payment-signature": SYNTHETIC_PAYMENT_VALUE }),
    ).toBe(true);
    expect(
      containsX402PaymentHeader({ "Payment-Signature": SYNTHETIC_PAYMENT_VALUE }),
    ).toBe(true);
    expect(
      containsX402PaymentHeader({ "x-PaYmEnT": SYNTHETIC_PAYMENT_VALUE }),
    ).toBe(true);
    expect(containsX402PaymentHeader({ "content-type": "text/plain" })).toBe(false);
  });

  it("works with a Headers object input", () => {
    const headers = new Headers();
    headers.set("X-PAYMENT", SYNTHETIC_PAYMENT_VALUE);

    expect(containsX402PaymentHeader(headers)).toBe(true);

    const guard = createPaymentBearingRequestGuard();
    guard.inspect(headers);
    expect(guard.getPaymentBearingRequests()).toBe(1);
  });

  it("detects payment headers attached to a Request object", () => {
    const request = new Request("http://localhost:4021/paid/analyze-text", {
      method: "POST",
      headers: {
        "PAYMENT-SIGNATURE": SYNTHETIC_PAYMENT_VALUE,
      },
    });

    const guard = createPaymentBearingRequestGuard();
    guard.inspectRequest(request);

    expect(guard.getPaymentBearingRequests()).toBe(1);
  });

  it("works with a Record<string, string> input", () => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "PAYMENT-SIGNATURE": SYNTHETIC_PAYMENT_VALUE,
    };

    expect(containsX402PaymentHeader(headers)).toBe(true);

    const guard = createPaymentBearingRequestGuard();
    guard.inspect(headers);
    expect(guard.getPaymentBearingRequests()).toBe(1);
  });

  it("works with a tuple-array [string, string][] input", () => {
    const headers: [string, string][] = [
      ["Content-Type", "application/json"],
      ["x-payment", SYNTHETIC_PAYMENT_VALUE],
    ];

    expect(containsX402PaymentHeader(headers)).toBe(true);

    const guard = createPaymentBearingRequestGuard();
    guard.inspect(headers);
    expect(guard.getPaymentBearingRequests()).toBe(1);
  });

  it("never prints payment header values", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const guard = createPaymentBearingRequestGuard();
    guard.inspect({ "PAYMENT-SIGNATURE": SYNTHETIC_PAYMENT_VALUE });
    containsX402PaymentHeader({ "X-PAYMENT": SYNTHETIC_PAYMENT_VALUE });

    for (const spy of [logSpy, errorSpy, warnSpy]) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(SYNTHETIC_PAYMENT_VALUE);
      }
    }
  });

  it("keeps the max payment-bearing requests fixed at one", () => {
    expect(MAX_PAYMENT_ATTEMPTS).toBe(1);

    const guard = createPaymentBearingRequestGuard();
    guard.inspect({ "PAYMENT-SIGNATURE": SYNTHETIC_PAYMENT_VALUE });
    expect(() =>
      guard.inspect({ "PAYMENT-SIGNATURE": SYNTHETIC_PAYMENT_VALUE }),
    ).toThrow("refusing more than one payment-bearing HTTP request");
  });
});
