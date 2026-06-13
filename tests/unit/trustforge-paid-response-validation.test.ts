import { describe, expect, it } from "vitest";

import {
  validatePaidResponseForPolicy,
  type PaidResponse,
} from "../../tools/trustforge/external-x402-paid-executor";
import { ONESOURCE_ETHEREUM_CHAIN_ID_POLICY } from "../../tools/trustforge/external-x402-get-policy";
import type { ExternalHandshakeInspection } from "../../tools/trustforge/external-x402-get-adapter";

const POLICY = ONESOURCE_ETHEREUM_CHAIN_ID_POLICY;

// validatePaidResponseForPolicy only reads inspection.quoteUsdc.
const INSPECTION = { quoteUsdc: "0.001" } as ExternalHandshakeInspection;

function paidResponse(overrides: Partial<PaidResponse> = {}): PaidResponse {
  return {
    httpStatus: 200,
    responseHeadersSanitized: { "content-type": "application/json" },
    responseBodySanitized: { chain_id: "0x1" },
    responseBodySha256: "paid-body",
    responseBodyParseable: true,
    observedChainId: "0x1",
    actualAmountUsdc: "0.001",
    network: "eip155:8453",
    asset: "USDC",
    transactionHash: "0xabc",
    receipt: { ok: true },
    settlementEvidence: { ok: true },
    paymentEvidence: { ok: true },
    paymentInvocationCount: 1,
    paymentBearingRequestCount: 1,
    ...overrides,
  };
}

describe("validatePaidResponseForPolicy — T0C response mocks", () => {
  it("accepts a complete one-shot paid response", () => {
    expect(() => validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse())).not.toThrow();
  });

  it("rejects HTTP 500", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse({ httpStatus: 500 })),
    ).toThrow();
  });

  it("rejects an unparseable body", () => {
    expect(() =>
      validatePaidResponseForPolicy(
        POLICY,
        INSPECTION,
        paidResponse({ responseBodyParseable: false }),
      ),
    ).toThrow();
  });

  it("rejects a missing actual spend", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse({ actualAmountUsdc: null })),
    ).toThrow();
  });

  it("rejects spend above the cap", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse({ actualAmountUsdc: "0.01" })),
    ).toThrow();
  });

  it("rejects the wrong asset", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse({ asset: "DAI" })),
    ).toThrow();
  });

  it("rejects the wrong network", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse({ network: "eip155:1" })),
    ).toThrow();
  });

  it("rejects the wrong chain id", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse({ observedChainId: "0x89" })),
    ).toThrow();
  });

  it("rejects missing payment evidence", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, INSPECTION, paidResponse({ paymentEvidence: null })),
    ).toThrow();
  });

  it("rejects missing receipt and settlement evidence together", () => {
    expect(() =>
      validatePaidResponseForPolicy(
        POLICY,
        INSPECTION,
        paidResponse({ receipt: null, settlementEvidence: null }),
      ),
    ).toThrow();
  });

  it("rejects more than one payment-bearing request reported", () => {
    expect(() =>
      validatePaidResponseForPolicy(
        POLICY,
        INSPECTION,
        paidResponse({ paymentBearingRequestCount: 2 }),
      ),
    ).toThrow();
  });
});
