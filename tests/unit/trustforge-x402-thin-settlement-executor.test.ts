/**
 * A.2 method-aware thin-executor wiring tests.
 *
 * The shared executor, authorization validator, and live freshness preflight are
 * mocked. These tests load no key, contact no endpoint, create no payment header,
 * and cannot sign or send a payment.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../tools/trustforge/x402-single-settlement-executor", () => ({
  executeSingleX402Settlement: vi.fn(),
}));
vi.mock("../../tools/trustforge/validate-human-payment-authorization", () => ({
  validateHumanPaymentAuthorization: vi.fn(() => ({ valid: true, reasons: [] })),
}));
vi.mock("../../tools/trustforge/paid-quote-freshness-preflight", () => ({
  runPaidQuoteFreshnessPreflight: vi.fn(async () => ({ go: true, reasons: [] })),
}));

import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { DiscoveredSelectedCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import { executeSingleX402Settlement } from "../../tools/trustforge/x402-single-settlement-executor";
import { executeThinX402Settlement } from "../../tools/trustforge/x402-thin-settlement-executor";
import { MAINNET_X402_SETTLEMENT_PROFILE } from "../../tools/trustforge/x402-settlement-profile";

const ENDPOINT = "https://seller.example/x402";
const REQUEST_BODY = { tx: "0xabc", chain: "base" };
const coreMock = vi.mocked(executeSingleX402Settlement);

const authorization: HumanPaymentAuthorization = {
  authorization_schema_version: "trustforge_paid_probe_authorization.v1",
  decision: "authorize_one_payment",
  provider: "test-provider",
  service_id: "test-service",
  endpoint: ENDPOINT,
  network: MAINNET_NETWORK,
  asset: MAINNET_USDC_ADDRESS,
  buyer_wallet: MAINNET_X402_SETTLEMENT_PROFILE.buyerWallet,
  max_usdc: "0.001",
  max_payment_attempts: 1,
  allow_retry: false,
  require_dedicated_wallet: true,
  decided_at: "2026-07-28T00:00:00.000Z",
  rationale: "unit-test fixture only",
};

function selected(method: DiscoveredSelectedCandidate["method"]): DiscoveredSelectedCandidate {
  return {
    provider: authorization.provider,
    service_id: authorization.service_id,
    endpoint: ENDPOINT,
    method,
    quote_amount_usdc: "0.001",
    quote_atomic: "1000",
    authorized_pay_to: "0x1111111111111111111111111111111111111111",
    recommended_max_usdc: "0.001",
    network: MAINNET_NETWORK,
    asset: MAINNET_USDC_ADDRESS,
    buyer_wallet: MAINNET_X402_SETTLEMENT_PROFILE.buyerWallet,
    target_selection_audit: {
      selected_resource_url: ENDPOINT,
      handshake_status: "live_402_ok",
      fallback_resource_urls: [],
      scoring_rationale: ["unit-test fixture only"],
    },
    selected_at_utc: "2026-07-28T00:00:00.000Z",
  };
}

function cannedCoreResult(): unknown {
  return {
    ok: true,
    status: "HTTP_OK",
    httpStatus: 200,
    paymentAttempted: false,
    paymentBearingHttpRequestCount: 0,
    responseBodyPreview: "",
    buyerAddress: MAINNET_X402_SETTLEMENT_PROFILE.buyerWallet,
    facilitatorTransactionHash: null,
    facilitatorReceiptPath: null,
    facilitatorReceipt: { parseStatus: "absent" },
    attemptId: "attempt_unit_test",
    intentPath: "intent-unit-test.json",
  };
}

async function execute(method: DiscoveredSelectedCandidate["method"]) {
  return executeThinX402Settlement({
    profile: MAINNET_X402_SETTLEMENT_PROFILE,
    runDir: "D:\\tmp\\trustforge-a2-unit-test",
    auth: authorization,
    selected: selected(method),
    authorizationHash: "unit-test-authorization-hash",
    env: {},
    skipFreshnessPreflight: true,
    requestBody: REQUEST_BODY,
  });
}

describe("x402 thin settlement executor A.2 planner wiring", () => {
  beforeEach(() => {
    coreMock.mockReset();
    coreMock.mockResolvedValue(cannedCoreResult() as never);
  });

  it("calls the shared executor with POST exactly as before", async () => {
    await execute("POST");

    expect(coreMock).toHaveBeenCalledTimes(1);
    expect(coreMock.mock.calls[0]?.[0].request).toMatchObject({
      endpoint: ENDPOINT,
      method: "POST",
      body: REQUEST_BODY,
    });
  });

  it("calls the shared executor with GET query parameters and no body", async () => {
    await execute("GET");

    expect(coreMock).toHaveBeenCalledTimes(1);
    const request = coreMock.mock.calls[0]?.[0].request;
    expect(request.method).toBe("GET");
    expect(request.body).toBeUndefined();
    const url = new URL(request.endpoint);
    expect(url.origin + url.pathname).toBe(ENDPOINT);
    expect(url.searchParams.get("tx")).toBe("0xabc");
    expect(url.searchParams.get("chain")).toBe("base");
  });

  it.each(["PUT", "PATCH", "DELETE", "HEAD"] as const)(
    "blocks unsupported %s before the shared executor",
    async (method) => {
      await expect(execute(method)).rejects.toThrow(
        "BLOCKED_METHOD_NOT_SETTLEABLE: REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER",
      );
      expect(coreMock).not.toHaveBeenCalled();
    },
  );
});
