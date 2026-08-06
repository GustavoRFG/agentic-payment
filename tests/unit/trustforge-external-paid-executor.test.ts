import { describe, expect, it, vi } from "vitest";

import {
  TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
  defaultExternalPaidReadinessRunDir,
  requestFromPaidPolicy,
  sanitizeForExternalPaidEvidence,
  validatePaidResponseForPolicy,
  validateExternalPaidArming,
  validateExternalPaidExecutionRequest,
  validateInspectionForPaidPolicy,
  type ExternalPaidProbeDependencies,
  type ExternalPaidRequestContext,
  type PaidResponse,
} from "../../tools/trustforge/external-x402-paid-executor";
import { runExternalPaidProbe } from "../support/trustforge-paid-core-seams";
import {
  ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
  resolveExternalX402GetProbePolicy,
} from "../../tools/trustforge/external-x402-get-policy";
import type { ExternalHandshakeInspection } from "../../tools/trustforge/external-x402-get-adapter";

const POLICY = ONESOURCE_ETHEREUM_CHAIN_ID_POLICY;

function handshake(
  overrides: Partial<ExternalHandshakeInspection> = {},
): ExternalHandshakeInspection {
  return {
    policyId: POLICY.policyId,
    serviceId: POLICY.serviceId,
    endpointUrl: POLICY.exactUrl,
    method: "GET",
    observedAtUtc: "2026-06-11T00:00:00.000Z",
    httpStatus: 402,
    contentType: "application/json",
    x402VersionObserved: "2",
    paymentRequirementsLocation: "header",
    observedTopLevelFields: ["accepts", "x402Version"],
    observedPaymentFields: ["amount", "asset", "network", "payTo"],
    scheme: "exact",
    network: "eip155:8453",
    asset: "USDC",
    assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amountAtomic: "1000",
    quoteUsdc: "0.001",
    payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
    maxTimeoutSeconds: 3600,
    resourceDescription: "Ethereum chain ID",
    offerReceiptExtensionAdvertised: false,
    redirectObserved: false,
    requestCount: 1,
    paymentAttempted: false,
    walletUsed: false,
    responseHeadersSanitized: {},
    responseBodySanitized: { error: "Payment required" },
    responseBodySha256: "abc",
    responseHeadersSha256: "def",
    ...overrides,
  };
}

function paidResponse(
  overrides: Partial<PaidResponse> = {},
): PaidResponse {
  return {
    httpStatus: 200,
    responseHeadersSanitized: { "content-type": "application/json" },
    responseBodySanitized: { chain_id: "0x1" },
    responseBodySha256: "paid-body",
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

function deps(
  overrides: Partial<ExternalPaidProbeDependencies> = {},
): ExternalPaidProbeDependencies {
  return {
    inspectHandshake: vi.fn(async () => handshake()),
    verifyGroundTruthBefore: vi.fn(async () => ({
      ok: true,
      chainIdHex: "0x1",
      chainIdDecimal: 1,
      sources: ["mock"],
    })),
    verifyGroundTruthAfter: vi.fn(async () => ({
      ok: true,
      chainIdHex: "0x1",
      chainIdDecimal: 1,
      sources: ["mock"],
    })),
    loadWallet: vi.fn(async () => ({
      walletFingerprint: "wallet-fp",
      publicAddress: "0x0000000000000000000000000000000000000001",
    })),
    performPaidRequest: vi.fn(async (
      _policy,
      _wallet,
      _inspection,
      context: ExternalPaidRequestContext,
    ) => {
      context.paymentBearingGuard.inspect({ "PAYMENT-SIGNATURE": "mock" });
      return paidResponse();
    }),
    now: () => new Date("2026-06-11T00:00:00.000Z"),
    ...overrides,
  };
}

function armedRequest(overrides = {}) {
  return requestFromPaidPolicy(POLICY, {
    executePaid: true,
    readinessOnly: false,
    runId: "run_001",
    armingEnvValue: TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
    ...overrides,
  });
}

describe("TrustForge external paid executor policy and arming", () => {
  it("uses the consolidated TrustForge workspace for default readiness artifacts", () => {
    const runDir = defaultExternalPaidReadinessRunDir(
      new Date("2026-06-12T01:02:03.000Z"),
    );

    expect(runDir).toBe(
      "D:\\trustforge\\artifacts\\runs\\mvp-t0b-readiness\\run_20260612_010203",
    );
    expect(runDir).not.toContain("D:\\trustforge-");
  });

  it("rejects unknown policy", () => {
    expect(() => resolveExternalX402GetProbePolicy("unknown")).toThrow(
      "unknown external probe policy",
    );
  });

  it.each([
    ["host different", { url: "https://evil.example/api/chain/chain-id?network=ethereum" }],
    ["URL similar", { url: `${POLICY.exactUrl}/` }],
    ["path different", { url: "https://api.onesource.io/api/chain/block-number?network=ethereum" }],
    ["query different", { url: "https://api.onesource.io/api/chain/chain-id?network=sepolia" }],
    ["HTTP", { url: "http://api.onesource.io/api/chain/chain-id?network=ethereum" }],
    ["POST", { method: "POST" }],
    ["network different", { allowedNetwork: "eip155:84532" }],
    ["asset different", { allowedAsset: "ETH" }],
    ["total above cap", { maxTotalSpendUsdc: "0.005001" }],
    ["attempts above one", { maxPaymentAttempts: 2 }],
    ["redirect", { allowRedirects: true }],
    ["retry", { allowRetries: true }],
    ["fallback", { allowFallback: true }],
    ["batch", { batch: true }],
    ["loop", { loop: true }],
    ["scheduler", { scheduler: true }],
  ])("rejects %s", (_label, override) => {
    expect(() =>
      validateExternalPaidExecutionRequest(POLICY, armedRequest(override)),
    ).toThrow();
  });

  it("rejects quote above 0.005 USDC", () => {
    expect(() =>
      validateInspectionForPaidPolicy(POLICY, handshake({ quoteUsdc: "0.005001" })),
    ).toThrow("quote exceeds policy");
  });

  it("rejects missing --execute-paid", () => {
    expect(() =>
      validateExternalPaidExecutionRequest(
        POLICY,
        requestFromPaidPolicy(POLICY, { executePaid: false }),
      ),
    ).toThrow("--execute-paid");
  });

  it("rejects missing arming env var", () => {
    expect(() =>
      validateExternalPaidArming(armedRequest({ armingEnvValue: undefined })),
    ).toThrow("requires TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED");
  });

  it("rejects wrong arming env var", () => {
    expect(() =>
      validateExternalPaidArming(armedRequest({ armingEnvValue: "NO" })),
    ).toThrow("requires TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED");
  });

  it("rejects missing run id", () => {
    expect(() => validateExternalPaidArming(armedRequest({ runId: "" }))).toThrow(
      "--run-id",
    );
  });

  it("rejects readiness-only combined with execute-paid", () => {
    expect(() =>
      validateExternalPaidExecutionRequest(
        POLICY,
        requestFromPaidPolicy(POLICY, {
          readinessOnly: true,
          executePaid: true,
        }),
      ),
    ).toThrow("cannot be combined");
  });
});

describe("TrustForge external paid executor gate order", () => {
  it("does not load wallet when policy fails", async () => {
    const d = deps();
    const result = await runExternalPaidProbe(
      {
        policy: POLICY,
        request: armedRequest({ url: "https://evil.example" }),
        mode: "execute-paid",
      },
      d,
    );

    expect(result.status).toBe("FAIL_CLOSED_BEFORE_WALLET_LOAD");
    expect(d.inspectHandshake).not.toHaveBeenCalled();
    expect(d.loadWallet).not.toHaveBeenCalled();
  });

  it("does not load wallet when handshake fails", async () => {
    const d = deps({
      inspectHandshake: vi.fn(async () => {
        throw new Error("handshake failed");
      }),
    });
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.status).toBe("FAIL_CLOSED_BEFORE_WALLET_LOAD");
    expect(d.loadWallet).not.toHaveBeenCalled();
  });

  it.each([
    ["quote", handshake({ quoteUsdc: "0.005001" })],
    ["asset", handshake({ asset: "USDC", assetAddress: "0x0", network: "eip155:8453" })],
    ["network", handshake({ network: "eip155:84532" })],
  ])("does not load wallet when %s gate fails", async (_label, badHandshake) => {
    const d = deps({
      inspectHandshake: vi.fn(async () => badHandshake),
    });
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.status).toBe("FAIL_CLOSED_BEFORE_WALLET_LOAD");
    expect(d.loadWallet).not.toHaveBeenCalled();
  });

  it("does not load wallet when ground truth fails", async () => {
    const d = deps({
      verifyGroundTruthBefore: vi.fn(async () => ({
        ok: false,
        chainIdHex: "0x2",
        chainIdDecimal: 2,
      })),
    });
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.status).toBe("FAIL_CLOSED_BEFORE_WALLET_LOAD");
    expect(d.loadWallet).not.toHaveBeenCalled();
  });

  it("does not load wallet when arming fails", async () => {
    const d = deps();
    const result = await runExternalPaidProbe(
      {
        policy: POLICY,
        request: armedRequest({ armingEnvValue: undefined }),
        mode: "execute-paid",
      },
      d,
    );

    expect(result.states).toContain("GROUND_TRUTH_BEFORE_CONFIRMED");
    expect(result.status).toBe("FAIL_CLOSED_BEFORE_WALLET_LOAD");
    expect(d.loadWallet).not.toHaveBeenCalled();
  });
});

describe("TrustForge external paid executor one-shot behavior", () => {
  it("calls the paid request at most once on success", async () => {
    const d = deps();
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.status).toBe("PASS");
    expect(result.paymentAttempts).toBe(1);
    expect(result.paymentBearingRequests).toBe(1);
    expect(d.performPaidRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["post-payment failure", async () => { throw new Error("paid failed"); }],
    ["post-payment timeout", async () => { throw new Error("paid timeout"); }],
    ["missing receipt", async (_context: ExternalPaidRequestContext) => paidResponse({ receipt: null })],
    ["incorrect response", async () => paidResponse({ observedChainId: "0x2" })],
  ])("does not retry on %s", async (_label, performPaidRequest) => {
    const d = deps({
      performPaidRequest: vi.fn(async (
        _policy,
        _wallet,
        _inspection,
        context: ExternalPaidRequestContext,
      ) => {
        context.paymentBearingGuard.inspect({ "PAYMENT-SIGNATURE": "mock" });
        return performPaidRequest(context);
      }),
    });
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.paymentAttempts).toBe(1);
    expect(result.retryUsed).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(d.performPaidRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["HTTP 500", paidResponse({ httpStatus: 500 })],
    ["HTTP 402", paidResponse({ httpStatus: 402 })],
    ["invalid body", paidResponse({ responseBodyParseable: false })],
    ["chain id incorrect", paidResponse({ observedChainId: "0x2" })],
    ["actual spend absent", paidResponse({ actualAmountUsdc: null })],
    ["actual spend above cap", paidResponse({ actualAmountUsdc: "0.006" })],
    ["network incorrect", paidResponse({ network: "eip155:84532" })],
    ["asset incorrect", paidResponse({ asset: "ETH" })],
    ["payment evidence absent", paidResponse({ paymentEvidence: null })],
    [
      "receipt and settlement absent",
      paidResponse({ receipt: null, settlementEvidence: null }),
    ],
  ])("rejects post-payment validation failure: %s", async (_label, response) => {
    const d = deps({
      performPaidRequest: vi.fn(async (
        _policy,
        _wallet,
        _inspection,
        context: ExternalPaidRequestContext,
      ) => {
        context.paymentBearingGuard.inspect({ "PAYMENT-SIGNATURE": "mock" });
        return response;
      }),
    });
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.status).toBe("FAIL_AFTER_PAYMENT");
    expect(result.paymentAttempts).toBe(1);
    expect(result.paymentBearingRequests).toBe(1);
    expect(d.performPaidRequest).toHaveBeenCalledTimes(1);
  });

  it("rejects ground truth after failure without retry", async () => {
    const d = deps({
      verifyGroundTruthAfter: vi.fn(async () => ({
        ok: false,
        chainIdHex: "0x2",
        chainIdDecimal: 2,
      })),
    });
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.status).toBe("FAIL_AFTER_PAYMENT");
    expect(result.paymentAttempts).toBe(1);
    expect(d.performPaidRequest).toHaveBeenCalledTimes(1);
  });

  it("fails when the paid transport does not emit exactly one payment-bearing request", async () => {
    const d = deps({
      performPaidRequest: vi.fn(async () => paidResponse({ paymentBearingRequestCount: 0 })),
    });
    const result = await runExternalPaidProbe(
      { policy: POLICY, request: armedRequest(), mode: "execute-paid" },
      d,
    );

    expect(result.status).toBe("FAIL_AFTER_PAYMENT");
    expect(result.paymentBearingRequests).toBe(0);
  });
});

describe("TrustForge external paid response validation", () => {
  it("accepts a complete one-shot paid response", () => {
    expect(() =>
      validatePaidResponseForPolicy(POLICY, handshake(), paidResponse()),
    ).not.toThrow();
  });
});

describe("TrustForge external paid executor sanitization", () => {
  it("redacts sensitive headers and payloads", () => {
    const sanitized = sanitizeForExternalPaidEvidence({
      authorization: "Bearer secret",
      cookie: "a=b",
      "set-cookie": "a=b",
      "payment-signature": "sig",
      "x-payment": "xpay",
      privateKey: "0xsecret",
      nested: {
        reusableSignedPayload: "payload",
        benign: "ok",
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("Bearer secret");
    expect(JSON.stringify(sanitized)).not.toContain("0xsecret");
    expect(JSON.stringify(sanitized)).not.toContain("payload");
    expect(JSON.stringify(sanitized)).toContain("[REDACTED]");
    expect(JSON.stringify(sanitized)).toContain("ok");
  });
});
