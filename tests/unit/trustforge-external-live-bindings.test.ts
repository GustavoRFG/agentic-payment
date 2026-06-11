import { describe, expect, it, vi } from "vitest";

import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import {
  dependenciesForMode,
  modeFromArgs,
  parseArgs,
} from "../../tools/run-trustforge-external-paid-smoke";
import type { ExternalHandshakeInspection } from "../../tools/trustforge/external-x402-get-adapter";
import { ONESOURCE_ETHEREUM_CHAIN_ID_POLICY } from "../../tools/trustforge/external-x402-get-policy";
import {
  loadExternalBuyerWalletFromEnv,
  performExternalX402PaidGetRequest,
  verifyEthereumMainnetChainId,
} from "../../tools/trustforge/external-x402-live-bindings";

const POLICY = ONESOURCE_ETHEREUM_CHAIN_ID_POLICY;

function handshake(): ExternalHandshakeInspection {
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
  };
}

describe("TrustForge external paid CLI routing", () => {
  it("rejects ambiguous and missing modes", () => {
    expect(() =>
      parseArgs(["--policy", POLICY.policyId, "--readiness-only", "--execute-paid"]),
    ).toThrow("cannot be combined");
    expect(() => parseArgs(["--policy", POLICY.policyId])).toThrow(
      "must pass --readiness-only or --execute-paid",
    );
  });

  it("selects readiness dependencies separately from paid dependencies", async () => {
    const readinessArgs = parseArgs([
      "--policy",
      POLICY.policyId,
      "--readiness-only",
    ]);
    const paidArgs = parseArgs([
      "--policy",
      POLICY.policyId,
      "--execute-paid",
      "--run-id",
      "run_001",
    ]);

    expect(modeFromArgs(readinessArgs)).toBe("readiness-only");
    expect(modeFromArgs(paidArgs)).toBe("execute-paid");
    await expect(
      dependenciesForMode("readiness-only").loadWallet(POLICY, handshake()),
    ).rejects.toThrow("readiness-only");
    await expect(
      dependenciesForMode("execute-paid").loadWallet(POLICY, handshake()),
    ).rejects.toThrow("BUYER_PRIVATE_KEY");
  });
});

describe("TrustForge external live paid bindings", () => {
  it("loads wallet from env without exposing private key", async () => {
    const wallet = await loadExternalBuyerWalletFromEnv({
      policy: POLICY,
      inspection: handshake(),
      env: {
        BUYER_PRIVATE_KEY:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
      importModule: async () => ({
        privateKeyToAccount: () => ({
          address: "0x0000000000000000000000000000000000000001",
        }),
      }),
    });

    expect(wallet.walletFingerprint).toHaveLength(16);
    expect(wallet.publicAddress).toBe("0x0000000000000000000000000000000000000001");
    expect(JSON.stringify(wallet)).not.toContain("111111111111");
  });

  it("verifies Ethereum mainnet chain id through independent RPC mocks", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const result = await verifyEthereumMainnetChainId({
      fetchImpl,
      sources: ["https://rpc-a.example", "https://rpc-b.example"],
    });

    expect(result.ok).toBe(true);
    expect(result.chainIdHex).toBe("0x1");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("connects the payment-bearing guard to the paid transport", async () => {
    const paidInvocationGuard = createPaidInvocationGuard(1);
    const paymentBearingGuard = createPaymentBearingRequestGuard(1);
    paidInvocationGuard.assertNext();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const response = await performExternalX402PaidGetRequest({
      policy: POLICY,
      inspection: handshake(),
      wallet: {
        walletFingerprint: "wallet-fp",
        signer: { address: "0x0000000000000000000000000000000000000001" },
      },
      context: {
        paidInvocationGuard,
        paymentBearingGuard,
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      createPaymentFetch: ({ guardedFetch }) => async (input, init) => {
        await guardedFetch(input, {
          ...init,
          headers: { "PAYMENT-SIGNATURE": "synthetic-test-signature" },
        });
        return new Response(JSON.stringify({ chain_id: "0x1" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "payment-response": "synthetic-response",
          },
        });
      },
      importModule: async () => ({
        decodePaymentResponseHeader: () => ({
          success: true,
          network: "eip155:8453",
          transaction: "0xabc",
        }),
      }),
    });

    expect(paymentBearingGuard.getPaymentBearingRequests()).toBe(1);
    expect(response.paymentBearingRequestCount).toBe(1);
    expect(response.paymentInvocationCount).toBe(1);
    expect(response.httpStatus).toBe(200);
    expect(response.observedChainId).toBe("0x1");
    expect(response.actualAmountUsdc).toBe("0.001");
    expect(response.paymentEvidence).toBeTruthy();
    expect(response.transactionHash).toBe("0xabc");
  });

  it("refuses a second payment-bearing request from the transport", async () => {
    const paidInvocationGuard = createPaidInvocationGuard(1);
    const paymentBearingGuard = createPaymentBearingRequestGuard(1);
    paidInvocationGuard.assertNext();

    await expect(
      performExternalX402PaidGetRequest({
        policy: POLICY,
        inspection: handshake(),
        wallet: {
          walletFingerprint: "wallet-fp",
          signer: { address: "0x0000000000000000000000000000000000000001" },
        },
        context: {
          paidInvocationGuard,
          paymentBearingGuard,
        },
        fetchImpl: (async () => new Response("{}", { status: 200 })) as typeof fetch,
        createPaymentFetch: ({ guardedFetch }) => async (input, init) => {
          await guardedFetch(input, {
            ...init,
            headers: { "PAYMENT-SIGNATURE": "first" },
          });
          await guardedFetch(input, {
            ...init,
            headers: { "PAYMENT-SIGNATURE": "second" },
          });
          return new Response(JSON.stringify({ chain_id: "0x1" }), { status: 200 });
        },
      }),
    ).rejects.toThrow("refusing more than one payment-bearing HTTP request");
  });
});
