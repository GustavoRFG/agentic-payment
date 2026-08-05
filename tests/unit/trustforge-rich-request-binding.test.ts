import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { coreMock } = vi.hoisted(() => ({ coreMock: vi.fn() }));

vi.mock("../../tools/trustforge/x402-single-settlement-executor", () => ({
  executeSingleX402Settlement: coreMock,
}));

import * as networkGuards from "../../tools/trustforge/settlement-network-guards";
import {
  createRichPaidGuards,
  performRichTxExplainerPaidRequest,
} from "../../tools/trustforge/rich-tx-explainer-live-bindings";
import {
  PHASE2_FIXTURE_TX,
  ZAPPER_TX_EXPLAINER_POLICY,
} from "../../tools/trustforge/rich-tx-explainer-policy";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
} from "../../tools/trustforge/thin-settlement-request-binding";

const POLICY = ZAPPER_TX_EXPLAINER_POLICY;
const BINDING = createThinSettlementRequestBinding({
  endpoint: POLICY.endpointUrl,
  method: POLICY.method,
  input_status: "known",
  query: [],
  body: POLICY.buildRequestBody(PHASE2_FIXTURE_TX, POLICY.targetChainId),
});

const HANDSHAKE = {
  policyId: POLICY.policyId,
  serviceId: POLICY.serviceId,
  endpointUrl: POLICY.endpointUrl,
  method: POLICY.method,
  httpStatus: 402,
  quoteUsdc: "0.001125",
  network: "eip155:8453",
  asset: "USDC",
  assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
  amountAtomic: "1125",
  requestBody: BINDING.body,
  responseBodySha256: "fixture",
  responseHeadersSanitized: {},
  responseBodySanitized: {},
  observedAtUtc: "2026-08-04T00:00:00.000Z",
  walletUsed: false as const,
  paymentAttempted: false as const,
};

function options(overrides: Record<string, unknown> = {}) {
  const guards = createRichPaidGuards();
  return {
    policy: POLICY,
    handshake: HANDSHAKE,
    authorizedMethod: "POST" as const,
    authorizedRequestBindingSha256: BINDING.binding_sha256,
    authorizedRequestSummary: thinSettlementRequestSummary(BINDING),
    txHash: PHASE2_FIXTURE_TX,
    wallet: { walletFingerprint: "test-wallet" },
    paidInvocationGuard: guards.paidInvocationGuard,
    paymentBearingGuard: guards.paymentBearingGuard,
    runDir: "D:\\tmp\\trustforge-rich-binding-test",
    authorizationHash: "human-artifact-hash",
    env: {},
    fetchImpl: vi.fn() as unknown as typeof fetch,
    ...overrides,
  };
}

describe("rich request authorization source", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    coreMock.mockReset();
    coreMock.mockResolvedValue({
      httpStatus: 200,
      responseBody: JSON.stringify({ ok: true }),
      responseHeaders: new Headers({ "content-type": "application/json" }),
      paymentBearingHttpRequestCount: 0,
      facilitatorTransactionHash: null,
      intentPath: "settlement_intent_test.json",
      attemptId: "attempt_test",
    });
  });

  it.each([
    [
      "missing hash",
      { authorizedRequestBindingSha256: null },
      "BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING",
    ],
    [
      "missing summary",
      { authorizedRequestSummary: null },
      "BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING",
    ],
    [
      "mismatched hash",
      { authorizedRequestBindingSha256: "0".repeat(64) },
      "BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH",
    ],
  ])("blocks %s before key guard or fetch", async (_label, override, reason) => {
    const keyGuard = vi.spyOn(networkGuards, "assertSettlementNetworkGuards");
    const input = options(override);

    await expect(performRichTxExplainerPaidRequest(input)).rejects.toThrow(reason);

    expect(coreMock).not.toHaveBeenCalled();
    expect(keyGuard).not.toHaveBeenCalled();
    expect(input.fetchImpl).not.toHaveBeenCalled();
    expect(input.paymentBearingGuard.getPaymentBearingRequests()).toBe(0);
  });

  it.each([
    ["body", { txHash: "0x" + "f".repeat(64) }],
    ["endpoint", { handshake: { ...HANDSHAKE, endpointUrl: `${POLICY.endpointUrl}/changed` } }],
    [
      "method",
      {
        policy: {
          ...POLICY,
          method: "GET" as const,
          buildRequestBody: () => null,
        },
      },
    ],
  ])("blocks altered rich %s before shared execution", async (_label, override) => {
    const keyGuard = vi.spyOn(networkGuards, "assertSettlementNetworkGuards");
    const input = options(override);

    await expect(performRichTxExplainerPaidRequest(input)).rejects.toThrow(/BLOCKED_/);

    expect(coreMock).not.toHaveBeenCalled();
    expect(keyGuard).not.toHaveBeenCalled();
    expect(input.fetchImpl).not.toHaveBeenCalled();
    expect(input.paymentBearingGuard.getPaymentBearingRequests()).toBe(0);
  });

  it("passes an independently supplied matching hash to the shared executor", async () => {
    const input = options();
    const result = await performRichTxExplainerPaidRequest(input);

    expect(coreMock).toHaveBeenCalledTimes(1);
    const request = coreMock.mock.calls[0][0].request;
    expect(request.authorizedRequestBindingSha256).toBe(BINDING.binding_sha256);
    expect(request.plannedRequestBinding.binding_sha256).toBe(BINDING.binding_sha256);
    expect(result.paymentBearingRequestCount).toBe(0);
    expect(input.fetchImpl).not.toHaveBeenCalled();
  });

  it("contains no runtime self-authorization assignment in the rich caller", () => {
    const source = readFileSync(
      join(process.cwd(), "tools", "trustforge", "rich-tx-explainer-live-bindings.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /authorizedRequestBindingSha256\s*:\s*(?:request|planned)\w*Binding\.binding_sha256/,
    );

    const phase6Source = readFileSync(
      join(process.cwd(), "tools", "run-trustforge-phase6-single-paid-rich-probe.ts"),
      "utf8",
    );
    expect(phase6Source.indexOf("planAuthorizedRichTxExplainerRequest({")).toBeLessThan(
      phase6Source.lastIndexOf("loadEnvForPaidProbe()"),
    );

    const orchestratorSource = readFileSync(
      join(process.cwd(), "tools", "run-trustforge-rich-tx-explainer.ts"),
      "utf8",
    );
    expect(orchestratorSource.indexOf("planAuthorizedRichTxExplainerRequest({")).toBeLessThan(
      orchestratorSource.indexOf("loadRichBuyerWallet(env)"),
    );
  });
});
