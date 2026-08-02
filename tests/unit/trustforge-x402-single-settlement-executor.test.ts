import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import * as networkGuards from "../../tools/trustforge/settlement-network-guards";
import {
  assertPaymentRequiredRailMatchesIntent,
  decodePaymentRequiredHeader,
  executeSingleX402Settlement,
  persistSettlementIntent,
  type SingleSettlementRequest,
} from "../../tools/trustforge/x402-single-settlement-executor";
import { buildSettlementIntent } from "../../tools/trustforge/settlement-run-binding";
import {
  TEST_SIGNING_ADDRESS_A,
  TEST_SIGNING_KEY_A,
} from "../../tools/trustforge/settlement-test-credentials";
import { SEPOLIA_BUYER_PRIVATE_KEY_ENV, SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";
import { TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import { planThinSettleRequest } from "../../tools/trustforge/thin-settlement-method-contract";

const AUTHORIZED_PAY_TO = "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71";
const AUTHORIZED_AMOUNT = "1000";
const SETTLEMENT_TX = "0x9ce1e957b4547ee86559e8b32af4a9a6e7087f8330096fde618abe4ea9ccf9a9";

vi.mock("@x402/fetch", () => ({
  x402Client: vi.fn(function X402Client(this: { register: ReturnType<typeof vi.fn> }) {
    this.register = vi.fn();
  }),
  wrapFetchWithPayment: (_fetch: typeof fetch) => async () => {
    const header = Buffer.from(
      JSON.stringify({
        success: true,
        transaction: "0x9ce1e957b4547ee86559e8b32af4a9a6e7087f8330096fde618abe4ea9ccf9a9",
        network: "eip155:84532",
        amount: "1000",
      }),
    ).toString("base64");
    return Response.json(
      { ok: true },
      { status: 200, headers: { "payment-response": header } },
    );
  },
}));

vi.mock("@x402/evm/exact/client", () => ({
  registerExactEvmScheme: vi.fn(),
}));

function build402Accept(overrides: Record<string, unknown> = {}): string {
  const accept = {
    scheme: "exact",
    network: TESTNET_NETWORK,
    asset: TESTNET_USDC_ADDRESS,
    amount: AUTHORIZED_AMOUNT,
    payTo: AUTHORIZED_PAY_TO,
    ...overrides,
  };
  return Buffer.from(JSON.stringify({ accepts: [accept] })).toString("base64");
}

function mock402Fetch(paymentRequiredHeader: string): typeof fetch {
  return vi.fn(async () =>
    Response.json(
      { error: "Payment required" },
      { status: 402, headers: { "payment-required": paymentRequiredHeader } },
    ),
  ) as typeof fetch;
}

function requestBindingFields(endpoint: string, method: "GET" | "POST", body: unknown) {
  const plannedRequestBinding = createThinSettlementRequestBinding({
    endpoint,
    method,
    input_status: "known",
    query: [],
    body: method === "GET" ? null : body,
  });
  return {
    authorizedRequestBindingSha256: plannedRequestBinding.binding_sha256,
    plannedRequestBinding,
  };
}

describe("x402-single-settlement-executor pre-live method binding", () => {
  /**
   * env is deliberately empty: if the binding did not block first, the call would fail
   * on the missing key instead. Asserting the binding error proves it blocks before
   * any key is read, nothing is signed, and no request is made.
   */
  function requestWith(method: "GET" | "POST", authorizedMethod: string | null) {
    const endpoint = "https://seller.example/x402";
    return {
      network: TESTNET_NETWORK,
      privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
      expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
      endpoint,
      method,
      authorizedMethod,
      body: method === "POST" ? null : undefined,
      ...requestBindingFields(endpoint, method, null),
      asset: TESTNET_USDC_ADDRESS,
      payTo: AUTHORIZED_PAY_TO,
      quotedAmountAtomic: AUTHORIZED_AMOUNT,
      maxAmountAtomic: AUTHORIZED_AMOUNT,
      runDir: "D:\\tmp\\trustforge-binding-unit-test",
      authorizationHash: "unit-test-hash",
    } as const;
  }

  it.each([
    ["POST", "GET"],
    ["GET", "POST"],
  ] as const)("blocks request %s against authorized %s before loading a key", async (m, a) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      executeSingleX402Settlement({ request: requestWith(m, a), env: {}, fetchImpl }),
    ).rejects.toThrow("BLOCKED_AUTHORIZATION_METHOD_MISMATCH");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["absent", "undefined"] as const)(
    "blocks an %s authorized method before loading a key or creating a payment header",
    async (variant) => {
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const paymentBearingGuard = createPaymentBearingRequestGuard({
        maxPaymentBearingRequests: 1,
      });
      const completeRequest = requestWith("POST", "POST");
      const { authorizedMethod: _omitted, ...requestWithoutMethod } = completeRequest;
      const request =
        variant === "absent"
          ? requestWithoutMethod
          : { ...completeRequest, authorizedMethod: undefined };
      const keyGuard = vi.spyOn(networkGuards, "assertSettlementNetworkGuards");

      try {
        await expect(
          executeSingleX402Settlement({
            // Runtime defense is intentional: JavaScript callers can bypass the
            // required TypeScript field, so the shared executor must still fail closed.
            request: request as unknown as SingleSettlementRequest,
            env: {},
            fetchImpl,
            paymentBearingGuard,
          }),
        ).rejects.toThrow("BLOCKED_AUTHORIZATION_METHOD_MISSING");
        expect(keyGuard).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(paymentBearingGuard.getPaymentBearingRequests()).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("stamps the bound method into the persisted intent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-intent-method-"));
    try {
      const intent = buildSettlementIntent({
        attemptId: "attempt_method",
        runId: "run_method",
        authorizationHash: "hash_method",
        network: TESTNET_NETWORK,
        buyer: SEPOLIA_TESTNET_BUYER_WALLET,
        payTo: AUTHORIZED_PAY_TO,
        asset: TESTNET_USDC_ADDRESS,
        amountAtomic: AUTHORIZED_AMOUNT,
        method: "GET",
      });
      const saved = JSON.parse(await readFile(await persistSettlementIntent(dir, intent), "utf8"));
      expect(saved.method).toBe("GET");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each(["authorization", "planned"] as const)(
    "blocks a missing %s request binding before key read, fetch, or payment header",
    async (missing) => {
      const complete = requestWith("POST", "POST");
      const request = { ...complete } as Record<string, unknown>;
      delete request[
        missing === "authorization"
          ? "authorizedRequestBindingSha256"
          : "plannedRequestBinding"
      ];
      const keyGuard = vi.spyOn(networkGuards, "assertSettlementNetworkGuards");
      const fetchImpl = vi.fn() as unknown as typeof fetch;
      const paymentBearingGuard = createPaymentBearingRequestGuard({
        maxPaymentBearingRequests: 1,
      });
      try {
        await expect(
          executeSingleX402Settlement({
            request: request as unknown as SingleSettlementRequest,
            env: {},
            fetchImpl,
            paymentBearingGuard,
          }),
        ).rejects.toThrow(
          missing === "authorization"
            ? "BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING"
            : "BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH",
        );
        expect(keyGuard).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        expect(paymentBearingGuard.getPaymentBearingRequests()).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  it("blocks changed GET query and POST body before key read", async () => {
    const keyGuard = vi.spyOn(networkGuards, "assertSettlementNetworkGuards");
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const getBinding = createThinSettlementRequestBinding({
      endpoint: "https://api.onesource.io/api/chain/network-info",
      method: "GET",
      input_status: "known",
      query: { network: "ethereum" },
      body: null,
    });
    const postBinding = createThinSettlementRequestBinding({
      endpoint: "https://seller.example/x402",
      method: "POST",
      input_status: "known",
      query: [],
      body: { network: "ethereum" },
    });
    try {
      for (const request of [
        {
          ...requestWith("GET", "GET"),
          endpoint: "https://api.onesource.io/api/chain/network-info?network=base",
          authorizedRequestBindingSha256: getBinding.binding_sha256,
          plannedRequestBinding: getBinding,
        },
        {
          ...requestWith("POST", "POST"),
          endpoint: postBinding.endpoint,
          body: { network: "base" },
          authorizedRequestBindingSha256: postBinding.binding_sha256,
          plannedRequestBinding: postBinding,
        },
      ]) {
        await expect(
          executeSingleX402Settlement({ request, env: {}, fetchImpl }),
        ).rejects.toThrow("BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH");
      }
      expect(keyGuard).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("x402-single-settlement-executor", () => {
  it("preserves a complete GET request binding through planner, intent, and outbound", async () => {
    vi.spyOn(networkGuards, "assertSettlementNetworkGuards").mockReturnValue({
      privateKey: TEST_SIGNING_KEY_A,
      buyerAddress: TEST_SIGNING_ADDRESS_A,
      chainId: 84532,
    });
    const binding = createThinSettlementRequestBinding({
      endpoint: "https://api.onesource.io/api/chain/network-info",
      method: "GET",
      input_status: "known",
      query: { network: "ethereum" },
      body: null,
    });
    const plan = planThinSettleRequest({ requestBinding: binding });
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    const dir = await mkdtemp(join(tmpdir(), "tf-get-binding-"));
    try {
      const result = await executeSingleX402Settlement({
        request: {
          network: TESTNET_NETWORK,
          privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
          expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
          endpoint: plan.endpoint,
          method: plan.method,
          authorizedMethod: "GET",
          authorizedRequestBindingSha256: binding.binding_sha256,
          plannedRequestBinding: binding,
          body: undefined,
          asset: TESTNET_USDC_ADDRESS,
          payTo: AUTHORIZED_PAY_TO,
          quotedAmountAtomic: AUTHORIZED_AMOUNT,
          maxAmountAtomic: "2000",
          runDir: dir,
          authorizationHash: "hash",
          require402BeforePayment: false,
        },
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A },
        fetchImpl: vi.fn(),
      });
      expect(new Set(Object.values(result.requestBinding)).size).toBe(1);
      expect(result.intent.request_summary).toMatchObject({
        method: "GET",
        query: [["network", "ethereum"]],
        body: null,
      });
      expect(result.paymentBearingHttpRequestCount).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it("persists pre-call settlement intent before request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-intent-"));
    try {
      const intent = buildSettlementIntent({
        attemptId: "attempt_test",
        runId: "run_test",
        authorizationHash: "hash_test",
        network: TESTNET_NETWORK,
        buyer: SEPOLIA_TESTNET_BUYER_WALLET,
        payTo: AUTHORIZED_PAY_TO,
        asset: TESTNET_USDC_ADDRESS,
        amountAtomic: AUTHORIZED_AMOUNT,
      });
      const path = await persistSettlementIntent(dir, intent);
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.attempt_id).toBe("attempt_test");
      expect(saved.authorization_hash).toBe("hash_test");
      expect(saved.request_started_at_utc).toBeTruthy();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses before signing when quote exceeds max", async () => {
    vi.spyOn(networkGuards, "assertSettlementNetworkGuards").mockReturnValue({
      privateKey: TEST_SIGNING_KEY_A,
      buyerAddress: TEST_SIGNING_ADDRESS_A,
      chainId: 84532,
    });
    await expect(
      executeSingleX402Settlement({
        request: {
          network: TESTNET_NETWORK,
          privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
          expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
          endpoint: "http://localhost:4021/paid/analyze-text",
          method: "POST",
          authorizedMethod: "POST",
          body: { text: "test" },
          ...requestBindingFields(
            "http://localhost:4021/paid/analyze-text",
            "POST",
            { text: "test" },
          ),
          asset: TESTNET_USDC_ADDRESS,
          payTo: AUTHORIZED_PAY_TO,
          quotedAmountAtomic: "5000",
          maxAmountAtomic: "1000",
          runDir: tmpdir(),
          authorizationHash: "hash",
        },
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/BLOCKED_QUOTE_EXCEEDS_MAX/);
    vi.restoreAllMocks();
  });

  it("refuses cross-network key before signing", async () => {
    await expect(
      executeSingleX402Settlement({
        request: {
          network: TESTNET_NETWORK,
          privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
          expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
          endpoint: "http://localhost:4021/paid/analyze-text",
          method: "POST",
          authorizedMethod: "POST",
          body: null,
          ...requestBindingFields("http://localhost:4021/paid/analyze-text", "POST", null),
          asset: TESTNET_USDC_ADDRESS,
          payTo: AUTHORIZED_PAY_TO,
          quotedAmountAtomic: AUTHORIZED_AMOUNT,
          maxAmountAtomic: "2000",
          runDir: tmpdir(),
          authorizationHash: "hash",
        },
        env: {
          [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A,
          BUYER_PRIVATE_KEY: "0x" + "11".repeat(32),
        },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/BLOCKED_CROSS_NETWORK_KEY/);
  });

  it("captures sanitized facilitator receipt artifact without persisting request headers", async () => {
    vi.spyOn(networkGuards, "assertSettlementNetworkGuards").mockReturnValue({
      privateKey: TEST_SIGNING_KEY_A,
      buyerAddress: TEST_SIGNING_ADDRESS_A,
      chainId: 84532,
    });
    const paymentBearingGuard = createPaymentBearingRequestGuard({ maxPaymentBearingRequests: 1 });
    paymentBearingGuard.inspectRequest = vi.fn();
    paymentBearingGuard.getPaymentBearingRequests = vi.fn(() => 1);
    const dir = await mkdtemp(join(tmpdir(), "tf-receipt-"));
    try {
      const result = await executeSingleX402Settlement({
        request: {
          network: TESTNET_NETWORK,
          privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
          expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
          endpoint: "http://localhost:4021/paid/analyze-text",
          method: "POST",
          authorizedMethod: "POST",
          body: { text: "test" },
          ...requestBindingFields(
            "http://localhost:4021/paid/analyze-text",
            "POST",
            { text: "test" },
          ),
          asset: TESTNET_USDC_ADDRESS,
          payTo: AUTHORIZED_PAY_TO,
          quotedAmountAtomic: AUTHORIZED_AMOUNT,
          maxAmountAtomic: "2000",
          runDir: dir,
          authorizationHash: "hash",
          require402BeforePayment: false,
        },
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A },
        fetchImpl: vi.fn(),
        paymentBearingGuard,
      });
      expect(result.facilitatorReceipt.parseStatus).toBe("parsed");
      expect(result.facilitatorTransactionHash).toBe(SETTLEMENT_TX.toLowerCase());
      expect(result.responseBody).toContain("ok");
      expect(result.facilitatorReceiptPath).toBeTruthy();
      const saved = JSON.parse(await readFile(result.facilitatorReceiptPath!, "utf8"));
      expect(saved.parse_status).toBe("parsed");
      expect(saved.transaction_hash).toBe(SETTLEMENT_TX.toLowerCase());
      expect(saved.contains_secret_material).toBe(false);
      expect(JSON.stringify(saved).toLowerCase()).not.toContain("privatekey");
      const intent = JSON.parse(await readFile(result.intentPath, "utf8"));
      expect(intent.request_binding_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(intent.request_summary).toMatchObject({
        method: "POST",
        endpoint: "http://localhost:4021/paid/analyze-text",
        query: [],
        body: { text: "test" },
      });
      expect(new Set(Object.values(result.requestBinding))).toHaveProperty("size", 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});

describe("payment-required intent match", () => {
  const intent = {
    network: TESTNET_NETWORK,
    asset: TESTNET_USDC_ADDRESS,
    payTo: AUTHORIZED_PAY_TO,
    amountAtomic: AUTHORIZED_AMOUNT,
  };

  it("accepts matching seller envelope", () => {
    const header = build402Accept();
    const envelope = decodePaymentRequiredHeader(header);
    expect(() => assertPaymentRequiredRailMatchesIntent(envelope, intent)).not.toThrow();
  });

  it.each([
    ["network", { network: "eip155:8453" }],
    ["asset", { asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }],
    ["pay_to", { payTo: "0x0000000000000000000000000000000000000001" }],
    ["amount", { amount: "999" }],
  ] as const)("rejects %s mismatch before signing", async (field, override) => {
    vi.spyOn(networkGuards, "assertSettlementNetworkGuards").mockReturnValue({
      privateKey: TEST_SIGNING_KEY_A,
      buyerAddress: TEST_SIGNING_ADDRESS_A,
      chainId: 84532,
    });
    const paymentBearingGuard = createPaymentBearingRequestGuard({ maxPaymentBearingRequests: 1 });
    const fetchImpl = mock402Fetch(build402Accept(override));

    await expect(
      executeSingleX402Settlement({
        request: {
          network: TESTNET_NETWORK,
          privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
          expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
          endpoint: "http://localhost:4021/paid/analyze-text",
          method: "POST",
          authorizedMethod: "POST",
          body: { text: "test" },
          ...requestBindingFields(
            "http://localhost:4021/paid/analyze-text",
            "POST",
            { text: "test" },
          ),
          asset: TESTNET_USDC_ADDRESS,
          payTo: AUTHORIZED_PAY_TO,
          quotedAmountAtomic: AUTHORIZED_AMOUNT,
          maxAmountAtomic: "2000",
          runDir: tmpdir(),
          authorizationHash: "hash",
          require402BeforePayment: true,
        },
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A },
        fetchImpl,
        paymentBearingGuard,
      }),
    ).rejects.toThrow(new RegExp(`BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: ${field}`));

    expect(paymentBearingGuard.getPaymentBearingRequests()).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
