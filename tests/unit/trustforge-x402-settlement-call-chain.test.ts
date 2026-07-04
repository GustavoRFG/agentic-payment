/**
 * Architectural regression guard for the thin x402 settlement call-chain.
 *
 * Proves the parameterized runner traverses exactly:
 *   runX402PaidSettlement -> executeThinX402Settlement -> executeSingleX402Settlement
 * for BOTH Sepolia and mainnet, with only the network profile changing.
 *
 * The test fails if a future refactor makes the runner call the shared core
 * (executeSingleX402Settlement) directly, or bypass executeThinX402Settlement.
 *
 * No real signature, no key load, no live endpoint: the shared core and the
 * network/freshness/validation dependencies are mocked, so nothing is signed or sent.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shared core is mocked -> no wallet, no RPC, no payment.
vi.mock("../../tools/trustforge/x402-single-settlement-executor", () => ({
  executeSingleX402Settlement: vi.fn(),
}));
// Freshness preflight would fetch the live endpoint -> stub it out.
vi.mock("../../tools/trustforge/paid-quote-freshness-preflight", () => ({
  runPaidQuoteFreshnessPreflight: vi.fn(async () => ({ go: true, reasons: [] })),
}));
// Authorization validation is exercised elsewhere; keep this test on the call-chain.
vi.mock("../../tools/trustforge/validate-human-payment-authorization", () => ({
  validateHumanPaymentAuthorization: vi.fn(() => ({ valid: true, reasons: [] })),
}));
// Wrap the REAL thin executor in a spy so we can assert it is on the path AND that
// it (not the runner) is what reaches the shared core.
vi.mock("../../tools/trustforge/x402-thin-settlement-executor", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../tools/trustforge/x402-thin-settlement-executor")>();
  return { ...actual, executeThinX402Settlement: vi.fn(actual.executeThinX402Settlement) };
});

import { runX402PaidSettlement } from "../../tools/trustforge/x402-paid-settlement-runner";
import { executeSingleX402Settlement } from "../../tools/trustforge/x402-single-settlement-executor";
import { executeThinX402Settlement } from "../../tools/trustforge/x402-thin-settlement-executor";
import {
  MAINNET_X402_SETTLEMENT_PROFILE,
  SEPOLIA_X402_SETTLEMENT_PROFILE,
  type X402SettlementProfile,
} from "../../tools/trustforge/x402-settlement-profile";

const thinSpy = vi.mocked(executeThinX402Settlement);
const coreMock = vi.mocked(executeSingleX402Settlement);

function cannedCoreResult(profile: X402SettlementProfile): unknown {
  return {
    ok: true,
    status: "HTTP_OK",
    httpStatus: 200,
    paymentAttempted: true,
    paymentBearingHttpRequestCount: 1,
    responseBodyPreview: "",
    buyerAddress: profile.buyerWallet,
    facilitatorTransactionHash: "0xabc",
    facilitatorReceiptPath: "receipt.json",
    facilitatorReceipt: { source: "payment-response-header", parseStatus: "parsed", transaction_hash: "0xabc" },
    attemptId: "attempt_1",
    intentPath: "intent.json",
  };
}

async function makeRunDir(network: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "x402-callchain-"));
  await writeFile(
    join(dir, "human_payment_authorization.json"),
    JSON.stringify({ decision: "APPROVE", max_usdc: "0.01" }),
    "utf8",
  );
  await writeFile(
    join(dir, "selected_candidate.json"),
    JSON.stringify({
      network,
      endpoint: "https://seller.example/x402",
      quote_amount_usdc: "0.001",
      quote_atomic: "1000",
      authorized_pay_to: "0xSeLLeR",
      asset: "0xUsDc",
    }),
    "utf8",
  );
  return dir;
}

async function runChain(profile: X402SettlementProfile, network: string) {
  coreMock.mockResolvedValue(cannedCoreResult(profile) as never);
  const runDir = await makeRunDir(network);
  try {
    await runX402PaidSettlement({ runDir, profile });
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
  const coreArg = coreMock.mock.calls[0]?.[0] as { request: Record<string, unknown> } | undefined;
  return coreArg;
}

describe("thin x402 settlement runner call-chain (architectural guard)", () => {
  beforeEach(() => {
    thinSpy.mockClear();
    coreMock.mockClear();
  });

  it("Sepolia: runX402PaidSettlement -> executeThinX402Settlement -> executeSingleX402Settlement", async () => {
    const coreArg = await runChain(SEPOLIA_X402_SETTLEMENT_PROFILE, "sepolia");

    // Thin wrapper is on the path (runner did not bypass it).
    expect(thinSpy).toHaveBeenCalledTimes(1);
    // Shared core reached exactly once (single-shot).
    expect(coreMock).toHaveBeenCalledTimes(1);
    // Ordering proves nesting: thin entered BEFORE the core (thin -> single, not single directly).
    expect(thinSpy.mock.invocationCallOrder[0]).toBeLessThan(coreMock.mock.invocationCallOrder[0]);
    // The core received the Sepolia profile's network-specific parameters.
    expect(coreArg?.request.privateKeyEnvName).toBe(SEPOLIA_X402_SETTLEMENT_PROFILE.privateKeyEnvName);
    expect(coreArg?.request.expectedNetworkIn402).toBe(SEPOLIA_X402_SETTLEMENT_PROFILE.caip2);
    expect(coreArg?.request.expectedBuyerAddress).toBe(SEPOLIA_X402_SETTLEMENT_PROFILE.buyerWallet);
    expect(coreArg?.request.require402BeforePayment).toBe(SEPOLIA_X402_SETTLEMENT_PROFILE.require402BeforePayment);
  });

  it("mainnet: identical chain, only the network profile changes", async () => {
    const coreArg = await runChain(MAINNET_X402_SETTLEMENT_PROFILE, "mainnet");

    expect(thinSpy).toHaveBeenCalledTimes(1);
    expect(coreMock).toHaveBeenCalledTimes(1);
    expect(thinSpy.mock.invocationCallOrder[0]).toBeLessThan(coreMock.mock.invocationCallOrder[0]);
    expect(coreArg?.request.privateKeyEnvName).toBe(MAINNET_X402_SETTLEMENT_PROFILE.privateKeyEnvName);
    expect(coreArg?.request.expectedNetworkIn402).toBe(MAINNET_X402_SETTLEMENT_PROFILE.caip2);
    expect(coreArg?.request.expectedBuyerAddress).toBe(MAINNET_X402_SETTLEMENT_PROFILE.buyerWallet);

    // "Only the profile changes": the two profiles are distinct on the fields the core keys on,
    // and each run routed its own profile through the same single chain.
    expect(SEPOLIA_X402_SETTLEMENT_PROFILE.id).toBe("sepolia");
    expect(MAINNET_X402_SETTLEMENT_PROFILE.id).toBe("mainnet");
    expect(MAINNET_X402_SETTLEMENT_PROFILE.privateKeyEnvName).not.toBe(
      SEPOLIA_X402_SETTLEMENT_PROFILE.privateKeyEnvName,
    );
    expect(MAINNET_X402_SETTLEMENT_PROFILE.caip2).not.toBe(SEPOLIA_X402_SETTLEMENT_PROFILE.caip2);
  });

  it("bypass guard: the shared core is never reached without the thin wrapper", async () => {
    await runChain(SEPOLIA_X402_SETTLEMENT_PROFILE, "sepolia");
    // If the runner ever calls executeSingleX402Settlement directly, thinSpy stays 0
    // while coreMock is >=1 and this invariant fails.
    expect(coreMock.mock.calls.length).toBeLessThanOrEqual(thinSpy.mock.calls.length);
    expect(thinSpy).toHaveBeenCalled();
  });
});
