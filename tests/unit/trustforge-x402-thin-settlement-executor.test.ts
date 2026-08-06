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
import { __testOnlyExecuteThinX402SettlementCore as executeThinX402Settlement } from "../../tools/trustforge/x402-thin-settlement-executor";
import { MAINNET_X402_SETTLEMENT_PROFILE } from "../../tools/trustforge/x402-settlement-profile";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
} from "../../tools/trustforge/thin-settlement-request-binding";
import {
  selectedCandidateSellerFields,
  sellerRequirementsFixture,
} from "./_trustforge-seller-requirements-fixture";

const ENDPOINT = "https://seller.example/x402";
const REQUEST_BODY = { tx: "0xabc", chain: "base" };
const coreMock = vi.mocked(executeSingleX402Settlement);

const authorization: HumanPaymentAuthorization = {
  authorization_schema_version: "trustforge_paid_probe_authorization.v1",
  decision: "authorize_one_payment",
  provider: "test-provider",
  service_id: "test-service",
  endpoint: ENDPOINT,
  method: "POST",
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
  const settleableMethod = method === "GET" ? "GET" : "POST";
  const requestBinding = createThinSettlementRequestBinding({
    endpoint: ENDPOINT,
    method: settleableMethod,
    input_status: "known",
    query: settleableMethod === "GET" ? REQUEST_BODY : [],
    body: settleableMethod === "GET" ? null : REQUEST_BODY,
  });
  const sellerRequirements = sellerRequirementsFixture({
    requestBindingSha256: requestBinding.binding_sha256,
    network: MAINNET_NETWORK,
    asset: MAINNET_USDC_ADDRESS,
    payTo: "0x1111111111111111111111111111111111111111",
    amountAtomic: "1000",
    endpoint: ENDPOINT,
  });
  return {
    ...selectedCandidateSellerFields(sellerRequirements),
    provider: authorization.provider,
    service_id: authorization.service_id,
    endpoint: ENDPOINT,
    method,
    request_input_status: "known",
    request_query: requestBinding.query,
    request_body: requestBinding.body,
    request_input_provenance: "bazaar.extensions.bazaar.info.input",
    request_binding_sha256: requestBinding.binding_sha256,
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
    requestBinding: {
      authorization_request_binding_sha256: "binding",
      selected_candidate_request_binding_sha256: "binding",
      planned_request_binding_sha256: "binding",
      intent_request_binding_sha256: "binding",
      outbound_request_binding_sha256: "binding",
    },
  };
}

async function executeWithAuth(
  method: DiscoveredSelectedCandidate["method"],
  auth: HumanPaymentAuthorization,
) {
  return executeThinX402Settlement({
    profile: MAINNET_X402_SETTLEMENT_PROFILE,
    runDir: "D:\\tmp\\trustforge-a2-unit-test",
    auth,
    selected: selected(method),
    authorizationHash: "unit-test-authorization-hash",
    env: {},
    skipFreshnessPreflight: true,
  });
}

/** Authorized method defaults to the candidate method (the bound, happy-path case). */
async function execute(
  method: DiscoveredSelectedCandidate["method"],
  authMethod: string | null = method,
) {
  const candidate = selected(method);
  const binding = createThinSettlementRequestBinding({
    endpoint: candidate.endpoint,
    method: method === "GET" ? "GET" : "POST",
    input_status: "known",
    query: candidate.request_query,
    body: candidate.request_body,
  });
  return executeWithAuth(method, {
    ...authorization,
    method: authMethod,
    request_binding_sha256: binding.binding_sha256,
    request_summary: thinSettlementRequestSummary(binding),
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

describe("pre-live authorization method binding at the thin executor", () => {
  beforeEach(() => {
    coreMock.mockReset();
    coreMock.mockResolvedValue(cannedCoreResult() as never);
  });

  it("passes POST end to end and forwards the authorized method", async () => {
    const result = await execute("POST", "POST");

    expect(coreMock).toHaveBeenCalledTimes(1);
    expect(coreMock.mock.calls[0]?.[0].request).toMatchObject({
      method: "POST",
      authorizedMethod: "POST",
    });
    expect(result.methodBinding).toMatchObject({
      authorization_method: "POST",
      selected_candidate_method: "POST",
      planned_method: "POST",
      intent_method: "POST",
      request_method: "POST",
    });
  });

  it("passes GET end to end with no body and forwards the authorized method", async () => {
    const result = await execute("GET", "GET");

    expect(coreMock).toHaveBeenCalledTimes(1);
    const request = coreMock.mock.calls[0]?.[0].request;
    expect(request.method).toBe("GET");
    expect(request.authorizedMethod).toBe("GET");
    expect(request.body).toBeUndefined();
    expect(result.methodBinding).toMatchObject({
      authorization_method: "GET",
      selected_candidate_method: "GET",
      planned_method: "GET",
      intent_method: "GET",
      request_method: "GET",
    });
  });

  it("blocks a POST authorization against a GET candidate before the shared executor", async () => {
    await expect(execute("GET", "POST")).rejects.toThrow(
      "BLOCKED_AUTHORIZATION_METHOD_MISMATCH",
    );
    expect(coreMock).not.toHaveBeenCalled();
  });

  it("blocks a GET authorization against a POST candidate before the shared executor", async () => {
    await expect(execute("POST", "GET")).rejects.toThrow(
      "BLOCKED_AUTHORIZATION_METHOD_MISMATCH",
    );
    expect(coreMock).not.toHaveBeenCalled();
  });

  it("blocks an authorization whose method key is absent entirely", async () => {
    const candidate = selected("POST");
    const binding = createThinSettlementRequestBinding({
      endpoint: candidate.endpoint,
      method: "POST",
      input_status: "known",
      query: candidate.request_query,
      body: candidate.request_body,
    });
    const { method: _omitted, ...authWithoutMethod } = {
      ...authorization,
      request_binding_sha256: binding.binding_sha256,
      request_summary: thinSettlementRequestSummary(binding),
    };
    await expect(
      executeWithAuth("POST", authWithoutMethod as HumanPaymentAuthorization),
    ).rejects.toThrow("BLOCKED_AUTHORIZATION_METHOD_MISSING");
    expect(coreMock).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])(
    "blocks an authorization with a blank method (%p) before the shared executor",
    async (authMethod) => {
      await expect(execute("POST", authMethod)).rejects.toThrow(
        "BLOCKED_AUTHORIZATION_METHOD_MISSING",
      );
      expect(coreMock).not.toHaveBeenCalled();
    },
  );

  it.each(["PUT", "PATCH", "DELETE", "HEAD"])(
    "blocks an unsupported authorized %s before the shared executor",
    async (authMethod) => {
      await expect(execute("POST", authMethod)).rejects.toThrow(
        /BLOCKED_AUTHORIZATION_METHOD_(UNSUPPORTED|MISMATCH)/,
      );
      expect(coreMock).not.toHaveBeenCalled();
    },
  );

  it("blocks missing or mismatched authorization request binding before the shared executor", async () => {
    await expect(
      executeWithAuth("POST", { ...authorization, method: "POST" }),
    ).rejects.toThrow("BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING");
    await expect(
      executeWithAuth("POST", {
        ...authorization,
        method: "POST",
        request_binding_sha256: "0".repeat(64),
      }),
    ).rejects.toThrow("BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH");
    expect(coreMock).not.toHaveBeenCalled();
  });

  it("detects selected-candidate request input tampering before the shared executor", async () => {
    const candidate = selected("GET");
    const auth = {
      ...authorization,
      method: "GET",
      request_binding_sha256: candidate.request_binding_sha256,
    };
    await expect(
      executeThinX402Settlement({
        profile: MAINNET_X402_SETTLEMENT_PROFILE,
        runDir: "D:\\tmp\\trustforge-a3-unit-test",
        auth,
        selected: { ...candidate, request_query: [] },
        authorizationHash: "unit-test-authorization-hash",
        env: {},
        skipFreshnessPreflight: true,
      }),
    ).rejects.toThrow("REJECTED_REQUEST_BINDING_INVALID");
    expect(coreMock).not.toHaveBeenCalled();
  });
});
