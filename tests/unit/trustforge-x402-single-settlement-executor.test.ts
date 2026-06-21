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
} from "../../tools/trustforge/x402-single-settlement-executor";
import { buildSettlementIntent } from "../../tools/trustforge/settlement-run-binding";
import {
  TEST_SIGNING_ADDRESS_A,
  TEST_SIGNING_KEY_A,
} from "../../tools/trustforge/settlement-test-credentials";
import { SEPOLIA_BUYER_PRIVATE_KEY_ENV, SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";
import { TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";

const AUTHORIZED_PAY_TO = "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71";
const AUTHORIZED_AMOUNT = "1000";

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

describe("x402-single-settlement-executor", () => {
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
          body: { text: "test" },
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
          body: { text: "test" },
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
