import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as networkGuards from "../../tools/trustforge/settlement-network-guards";
import {
  executeSingleX402Settlement,
  persistSettlementIntent,
} from "../../tools/trustforge/x402-single-settlement-executor";
import { buildSettlementIntent } from "../../tools/trustforge/settlement-run-binding";
import { SEPOLIA_BUYER_PRIVATE_KEY_ENV, SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";
import { TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";

const SEPOLIA_TEST_KEY = "0x" + "aa".repeat(32);

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
        payTo: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
        asset: TESTNET_USDC_ADDRESS,
        amountAtomic: "1000",
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
      privateKey: SEPOLIA_TEST_KEY,
      buyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
      chainId: 84532,
    });
    await expect(
      executeSingleX402Settlement({
        request: {
          network: TESTNET_NETWORK,
          privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
          expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
          endpoint: "http://localhost:4021/paid/analyze-text",
          method: "POST",
          body: { text: "test" },
          asset: TESTNET_USDC_ADDRESS,
          payTo: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
          quotedAmountAtomic: "5000",
          maxAmountAtomic: "1000",
          runDir: tmpdir(),
          authorizationHash: "hash",
        },
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: SEPOLIA_TEST_KEY },
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
          expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
          endpoint: "http://localhost:4021/paid/analyze-text",
          method: "POST",
          asset: TESTNET_USDC_ADDRESS,
          payTo: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
          quotedAmountAtomic: "1000",
          maxAmountAtomic: "2000",
          runDir: tmpdir(),
          authorizationHash: "hash",
        },
        env: {
          [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: SEPOLIA_TEST_KEY,
          BUYER_PRIVATE_KEY: "0x" + "11".repeat(32),
        },
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/BLOCKED_CROSS_NETWORK_KEY/);
  });
});
