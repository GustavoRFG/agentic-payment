import { beforeEach, describe, expect, it, vi } from "vitest";

const sensitive = vi.hoisted(() => ({
  randomUUID: vi.fn(() => "must-not-be-generated"),
  privateKeyToAccount: vi.fn(),
  x402Client: vi.fn(),
  wrapFetchWithPayment: vi.fn(),
  registerExactEvmScheme: vi.fn(),
  networkGuard: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: sensitive.randomUUID };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, mkdir: sensitive.mkdir, writeFile: sensitive.writeFile };
});

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: sensitive.privateKeyToAccount,
}));

vi.mock("@x402/fetch", () => ({
  x402Client: sensitive.x402Client,
  wrapFetchWithPayment: sensitive.wrapFetchWithPayment,
}));

vi.mock("@x402/evm/exact/client", () => ({
  registerExactEvmScheme: sensitive.registerExactEvmScheme,
}));

vi.mock("../../tools/trustforge/settlement-network-guards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../tools/trustforge/settlement-network-guards")>();
  return { ...actual, assertSettlementNetworkGuards: sensitive.networkGuard };
});

import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import {
  BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED,
} from "../../tools/trustforge/pre-b2-paid-execution-blocker";
import { runExternalPaidProbe } from "../../tools/trustforge/external-x402-paid-executor";
import { runX402PaidSettlement } from "../../tools/trustforge/x402-paid-settlement-runner";
import { executeSingleX402Settlement } from "../../tools/trustforge/x402-single-settlement-executor";
import { executeThinX402Settlement } from "../../tools/trustforge/x402-thin-settlement-executor";
import { runRichTxExplainerPhase3 } from "../../tools/run-trustforge-rich-tx-explainer";
import { runPhase6SinglePaidRichProbe } from "../../tools/run-trustforge-phase6-single-paid-rich-probe";
import { MAINNET_X402_SETTLEMENT_PROFILE } from "../../tools/trustforge/x402-settlement-profile";
import {
  createThinSettlementRequestBinding,
  thinSettlementRequestSummary,
} from "../../tools/trustforge/thin-settlement-request-binding";
import {
  humanAuthorizationSellerFields,
  selectedCandidateSellerFields,
  sellerRequirementsFixture,
} from "./_trustforge-seller-requirements-fixture";

const BLOCKER = BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED;

function expectNoSensitiveEffects(fetchImpl: ReturnType<typeof vi.fn>, paymentCount = 0): void {
  expect(sensitive.networkGuard).not.toHaveBeenCalled();
  expect(sensitive.privateKeyToAccount).not.toHaveBeenCalled();
  expect(sensitive.randomUUID).not.toHaveBeenCalled();
  expect(sensitive.x402Client).not.toHaveBeenCalled();
  expect(sensitive.registerExactEvmScheme).not.toHaveBeenCalled();
  expect(sensitive.wrapFetchWithPayment).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(paymentCount).toBe(0);
  expect(sensitive.mkdir).not.toHaveBeenCalled();
  expect(sensitive.writeFile).not.toHaveBeenCalled();
}

describe("absolute pre-B.2 paid execution blocker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("blocks the paid runner without reaching thin execution or artifacts", async () => {
    const result = await runX402PaidSettlement({
      runDir: "D:\\tmp\\trustforge-pre-b2-runner",
      profile: MAINNET_X402_SETTLEMENT_PROFILE,
    });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain(BLOCKER);
    expectNoSensitiveEffects(vi.fn());
  });

  it("blocks direct thin execution before environment/key/profile inspection", async () => {
    const fetchImpl = vi.fn();
    const env = new Proxy<Record<string, string | undefined>>(
      {},
      { get: () => { throw new Error("environment must not be read"); } },
    );
    await expect(
      executeThinX402Settlement({ env, fetchImpl } as never),
    ).rejects.toThrow(BLOCKER);
    expectNoSensitiveEffects(fetchImpl);
  });

  it("blocks even when all B.1 artifacts are valid, fresh, and apparently wallet-armed", async () => {
    const endpoint = "https://seller.example/paid";
    const requestBinding = createThinSettlementRequestBinding({
      endpoint,
      method: "GET",
      input_status: "known",
      query: { network: "ethereum" },
      body: null,
    });
    const requirements = sellerRequirementsFixture({
      requestBindingSha256: requestBinding.binding_sha256,
      network: "eip155:8453",
      asset: MAINNET_X402_SETTLEMENT_PROFILE.usdcContract,
      payTo: "0x1111111111111111111111111111111111111111",
      amountAtomic: "1000",
      endpoint,
      observedAt: "2026-08-06T00:00:00.000Z",
    });
    const selected = {
      ...selectedCandidateSellerFields(requirements),
      provider: "test",
      service_id: "test",
      endpoint,
      method: "GET" as const,
      request_input_status: "known" as const,
      request_query: requestBinding.query,
      request_body: requestBinding.body,
      request_input_provenance: "bazaar.extensions.bazaar.info.input" as const,
      request_binding_sha256: requestBinding.binding_sha256,
      quote_amount_usdc: "0.001",
      quote_atomic: "1000",
      authorized_pay_to: "0x1111111111111111111111111111111111111111",
      recommended_max_usdc: "0.001",
      asset: MAINNET_X402_SETTLEMENT_PROFILE.usdcContract,
      buyer_wallet: MAINNET_X402_SETTLEMENT_PROFILE.buyerWallet,
      target_selection_audit: {
        selected_resource_url: endpoint,
        handshake_status: "live_402_ok",
        fallback_resource_urls: [],
        scoring_rationale: ["valid B.1 synthetic fixture"],
      },
      selected_at_utc: "2026-08-06T00:00:00.000Z",
    };
    const auth = {
      ...humanAuthorizationSellerFields(requirements),
      decision: "authorize_one_payment",
      provider: "test",
      service_id: "test",
      endpoint,
      method: "GET",
      request_binding_sha256: requestBinding.binding_sha256,
      request_summary: thinSettlementRequestSummary(requestBinding),
      buyer_wallet: MAINNET_X402_SETTLEMENT_PROFILE.buyerWallet,
      max_usdc: "0.001",
      max_payment_attempts: 1,
      allow_retry: false,
      require_dedicated_wallet: true,
      rationale: "synthetic hard-block proof",
    };
    const fetchImpl = vi.fn();
    await expect(
      executeThinX402Settlement({
        profile: MAINNET_X402_SETTLEMENT_PROFILE,
        runDir: "D:\\tmp\\trustforge-pre-b2-valid-b1",
        auth,
        selected,
        authorizationHash: "a".repeat(64),
        env: { BUYER_PRIVATE_KEY: "apparently-configured-but-must-not-be-read" },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(BLOCKER);
    expectNoSensitiveEffects(fetchImpl);
  });

  it("blocks the shared executor before key guard, nonce RNG, signer, header, or fetch", async () => {
    const fetchImpl = vi.fn();
    const paymentGuard = createPaymentBearingRequestGuard({ maxPaymentBearingRequests: 1 });
    await expect(
      executeSingleX402Settlement({
        request: {} as never,
        env: { BUYER_PRIVATE_KEY: `0x${"1".repeat(64)}` },
        fetchImpl: fetchImpl as unknown as typeof fetch,
        paymentBearingGuard: paymentGuard,
      }),
    ).rejects.toThrow(BLOCKER);
    expectNoSensitiveEffects(fetchImpl, paymentGuard.getPaymentBearingRequests());
  });

  it("blocks rich paid orchestrators before env files, wallet load, fetch, or intent", async () => {
    const fetchImpl = vi.fn();
    await expect(
      runRichTxExplainerPhase3({
        executePaid: true,
        runDir: "D:\\tmp\\trustforge-pre-b2-rich",
        env: { BUYER_PRIVATE_KEY: `0x${"1".repeat(64)}` },
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(BLOCKER);
    await expect(
      runPhase6SinglePaidRichProbe({
        runDir: "D:\\tmp\\trustforge-pre-b2-phase6",
        env: { BUYER_PRIVATE_KEY: `0x${"1".repeat(64)}` },
      }),
    ).rejects.toThrow(BLOCKER);
    expectNoSensitiveEffects(fetchImpl);
  });

  it("blocks the legacy paid executor before handshake, wallet loader, or paid request", async () => {
    const inspectHandshake = vi.fn();
    const loadWallet = vi.fn();
    const performPaidRequest = vi.fn();
    const fetchImpl = vi.fn();
    await expect(
      runExternalPaidProbe(
        { mode: "execute-paid" } as never,
        {
          inspectHandshake,
          loadWallet,
          performPaidRequest,
        } as never,
      ),
    ).rejects.toThrow(BLOCKER);
    expect(inspectHandshake).not.toHaveBeenCalled();
    expect(loadWallet).not.toHaveBeenCalled();
    expect(performPaidRequest).not.toHaveBeenCalled();
    expectNoSensitiveEffects(fetchImpl);
  });
});
