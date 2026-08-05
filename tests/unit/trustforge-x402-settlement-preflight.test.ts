import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MAINNET_USDC_ADDRESS, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { MAINNET_BUYER_WALLET, SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";
import { ZAPPER_TX_EXPLAINER_POLICY } from "../../tools/trustforge/rich-tx-explainer-policy";
import type { AuthorizedPaymentQuote, PaidQuoteFreshnessPreflightResult } from "../../tools/trustforge/paid-quote-freshness-preflight";
import {
  runX402SettlementPreflight,
  X402PreflightRpcTimeoutError,
  type ChainStateReader,
  type X402PreflightResult,
} from "../../tools/trustforge/x402-settlement-preflight";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import {
  selectedCandidateSellerFields,
  sellerRequirementsFixture,
} from "./_trustforge-seller-requirements-fixture";

const NOW = new Date("2026-07-06T00:00:00.000Z");
const MAINNET_PAY_TO = "0x43a2a720cd0911690c248075f4a29a5e7716f758";
// Hardhat account #1 — a publicly-known TEST key, never a real wallet. Used only
// to exercise the wallet-mismatch branch; the real buyer key is never loaded.
const HARDHAT_TEST_KEY_1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const HARDHAT_ADDR_1 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

function makeRunDir(): string {
  return mkdtempSync(join(tmpdir(), "x402-preflight-"));
}

function mainnetCandidate(
  overrides: Record<string, unknown> = {},
  requirementsObservedAt = NOW.toISOString(),
) {
  const candidate = {
    provider: "zapper",
    service_id: "zapper_tx_explainer",
    endpoint: ZAPPER_TX_EXPLAINER_POLICY.endpointUrl,
    method: "POST" as const,
    quote_amount_usdc: "0.001125",
    quote_atomic: "1125",
    authorized_pay_to: MAINNET_PAY_TO,
    recommended_max_usdc: "0.01",
    network: "eip155:8453",
    asset: MAINNET_USDC_ADDRESS,
    buyer_wallet: MAINNET_BUYER_WALLET,
    target_selection_audit: {
      selected_resource_url: ZAPPER_TX_EXPLAINER_POLICY.endpointUrl,
      handshake_status: "live_402_ok",
      fallback_resource_urls: [],
      scoring_rationale: [],
    },
    selected_at_utc: NOW.toISOString(),
    ...overrides,
  };
  const binding = createThinSettlementRequestBinding({
    endpoint: String(candidate.endpoint),
    method: String(candidate.method),
    input_status: "known",
    query: [],
    body: candidate.method === "GET" ? null : {},
  });
  const sellerRequirements = sellerRequirementsFixture({
    requestBindingSha256: binding.binding_sha256,
    network: String(candidate.network),
    asset: String(candidate.asset),
    payTo: String(candidate.authorized_pay_to),
    amountAtomic: String(candidate.quote_atomic),
    endpoint: String(candidate.endpoint),
    observedAt: requirementsObservedAt,
  });
  return {
    ...candidate,
    ...selectedCandidateSellerFields(sellerRequirements),
    request_input_status: "known" as const,
    request_query: binding.query,
    request_body: binding.body,
    request_input_provenance: "legacy_explicit_request_binding" as const,
    request_binding_sha256: binding.binding_sha256,
  };
}

function sepoliaCandidate(overrides: Record<string, unknown> = {}) {
  const candidate = {
    provider: "sepolia_local_seller",
    service_id: "local_analyze_text",
    endpoint: "http://localhost:4021/paid/analyze-text",
    method: "POST" as const,
    quote_amount_usdc: "0.001",
    quote_atomic: "1000",
    authorized_pay_to: "0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392",
    recommended_max_usdc: "0.01",
    network: "eip155:84532",
    asset: TESTNET_USDC_ADDRESS,
    buyer_wallet: SEPOLIA_TESTNET_BUYER_WALLET,
    target_selection_audit: {
      selected_resource_url: "http://localhost:4021/paid/analyze-text",
      handshake_status: "live_402_ok",
      fallback_resource_urls: [],
      scoring_rationale: [],
    },
    selected_at_utc: NOW.toISOString(),
    ...overrides,
  };
  const binding = createThinSettlementRequestBinding({
    endpoint: String(candidate.endpoint),
    method: String(candidate.method),
    input_status: "known",
    query: [],
    body: { text: "TrustForge Sepolia freshness probe.", mode: "full" },
  });
  const sellerRequirements = sellerRequirementsFixture({
    requestBindingSha256: binding.binding_sha256,
    network: String(candidate.network),
    asset: String(candidate.asset),
    payTo: String(candidate.authorized_pay_to),
    amountAtomic: String(candidate.quote_atomic),
    endpoint: String(candidate.endpoint),
    observedAt: NOW.toISOString(),
  });
  return {
    ...candidate,
    ...selectedCandidateSellerFields(sellerRequirements),
    request_input_status: "known" as const,
    request_query: binding.query,
    request_body: binding.body,
    request_input_provenance: "legacy_explicit_request_binding" as const,
    request_binding_sha256: binding.binding_sha256,
  };
}

function writeCandidate(runDir: string, candidate: unknown): void {
  writeFileSync(join(runDir, "selected_candidate.json"), `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
}

function writeTargetSelection(
  runDir: string,
  candidate: ReturnType<typeof mainnetCandidate>,
  primaryUrl: string,
): void {
  writeFileSync(
    join(runDir, "target_selection.json"),
    `${JSON.stringify(
      {
        selection: {
          primary: { resourceUrl: primaryUrl },
          fallbacks: [
            {
              resourceUrl: candidate.endpoint,
              sellerRequirements: candidate.seller_requirements,
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function readerReturning(chainId: number): ChainStateReader {
  return async () => ({
    chainId,
    ethBalanceWei: 5_000_000_000_000_000n,
    usdcAtomic: 2_000n,
    rpcUsed: "stub://rpc",
  });
}

const timeoutReader: ChainStateReader = async () => {
  throw new X402PreflightRpcTimeoutError("all configured RPC urls failed");
};

const freshGo = async (): Promise<PaidQuoteFreshnessPreflightResult> => ({
  go: true,
  reasons: [],
  outcome: null,
  paytime_requirements_observed_at: NOW.toISOString(),
  effective_signing_deadline: null,
  fresh_unsigned_402_required_before_signing: false,
});
function freshNoGo(reasons: string[]) {
  return async (_quote: AuthorizedPaymentQuote): Promise<PaidQuoteFreshnessPreflightResult> => ({
    go: false,
    reasons,
    outcome: null,
    paytime_requirements_observed_at: null,
    effective_signing_deadline: null,
    fresh_unsigned_402_required_before_signing: true,
  });
}

function expectNoPayment(result: X402PreflightResult): void {
  expect(result.payment_bearing_http_request_count).toBe(0);
  expect(result.strict_no_payment).toBe("yes");
  expect(result.wallet_loaded).toBe("no");
  expect(result.signed).toBe(false);
  expect(result.rpc_silent_fallback).toBe(false);
}

describe("x402 settlement preflight — keyless mainnet + Sepolia", () => {
  it("mainnet happy path passes without a key", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshGo,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.blocker).toBeNull();
    expect(result.network_profile).toBe("mainnet");
    expect(result.caip2).toBe("eip155:8453");
    expect(result.chain_id_observed).toBe(8453);
    expect(result.asset_expected.toLowerCase()).toBe(MAINNET_USDC_ADDRESS.toLowerCase());
    expect(result.buyer_expected.toLowerCase()).toBe(MAINNET_BUYER_WALLET.toLowerCase());
    expect(result.authorized_pay_to).toBe(MAINNET_PAY_TO);
    expect(result.quote_atomic).toBe("1125");
    expect(result.fresh_402_go).toBe(true);
    expect(result.buyer_private_key_present).toBe(false);
    expect(result.sepolia_buyer_private_key_present).toBe(false);
    expectNoPayment(result);
  });

  it("mainnet preflight accepts a valid non-Zapper selected_candidate endpoint", async () => {
    const runDir = makeRunDir();
    const endpoint = "https://valid-provider.example/x402/tx-details";
    const candidate = mainnetCandidate({
        provider: "discovered_x402",
        service_id: "valid_provider_example_x402_tx_details",
        endpoint,
        method: "GET",
        target_selection_audit: {
          selected_resource_url: endpoint,
          handshake_status: "live_402_ok",
          fallback_resource_urls: [],
          scoring_rationale: ["price_atomic=1125"],
        },
      });
    writeCandidate(runDir, candidate);
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toBe(endpoint);
      expect(init?.method).toBe("GET");
      return new Response(
        JSON.stringify({ error: "Payment Required" }),
        {
          status: 402,
          headers: {
            "content-type": "application/json",
            "payment-required": Buffer.from(
              JSON.stringify(candidate.seller_requirements.payment_required_envelope),
              "utf8",
            ).toString("base64"),
          },
        },
      );
    }) as unknown as typeof fetch;

    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      fetchImpl,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.endpoint).toBe(endpoint);
    expect(result.fresh_402_go).toBe(true);
    expectNoPayment(result);
  });

  it("selected_candidate may come from target_selection fallback after explicit adapt selector", async () => {
    const runDir = makeRunDir();
    const autonomousEndpoint = "https://autonomous.example/x402/tx-details";
    const candidate = mainnetCandidate();
    writeTargetSelection(runDir, candidate, autonomousEndpoint);
    writeCandidate(runDir, candidate);
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshGo,
    });
    expect(result.ok).toBe(true);
    expect(result.candidate_belongs_to_run).toBe(true);
    expectNoPayment(result);
  });

  it("Sepolia happy path is preserved through the same core", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, sepoliaCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "sepolia",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(84532),
      freshness: freshGo,
    });
    expect(result.ok).toBe(true);
    expect(result.network_profile).toBe("sepolia");
    expect(result.chain_id_observed).toBe(84532);
    expectNoPayment(result);
  });

  it("wrong chain id blocks with BLOCKED_WRONG_CHAIN", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(1),
      freshness: freshGo,
    });
    expect(result.ok).toBe(false);
    expect(result.blocker).toBe("BLOCKED_WRONG_CHAIN");
    expectNoPayment(result);
  });

  it("wrong asset blocks with BLOCKED_WRONG_ASSET", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate({ asset: "0x0000000000000000000000000000000000000001" }));
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshGo,
    });
    expect(result.blocker).toBe("BLOCKED_WRONG_ASSET");
    expectNoPayment(result);
  });

  it("altered payTo blocks with BLOCKED_402_PAY_TO_MISMATCH", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshNoGo(["payTo mismatch fresh=0x1 authorized=0x2"]),
    });
    expect(result.blocker).toBe("BLOCKED_402_PAY_TO_MISMATCH");
    expectNoPayment(result);
  });

  it("altered quote blocks with BLOCKED_402_AMOUNT_MISMATCH", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshNoGo(["quote drift fresh_atomic=2000 authorized_atomic=1125"]),
    });
    expect(result.blocker).toBe("BLOCKED_402_AMOUNT_MISMATCH");
    expectNoPayment(result);
  });

  it("fresh 402 endpoint mismatch blocks with BLOCKED_402_ENDPOINT_MISMATCH", async () => {
    const runDir = makeRunDir();
    const endpoint = "https://candidate.example/x402/transaction-details";
    writeCandidate(
      runDir,
      mainnetCandidate({
        provider: "discovered_x402",
        service_id: "candidate_example_x402_transaction_details",
        endpoint,
        method: "GET",
      }),
    );
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: async (quote) => ({
        go: false,
        reasons: [`endpoint mismatch fresh=https://fresh.example/x402 authorized=${quote.endpoint}`],
        outcome: null,
      }),
    });
    expect(result.blocker).toBe("BLOCKED_402_ENDPOINT_MISMATCH");
    expectNoPayment(result);
  });

  it("stale candidate blocks with BLOCKED_STALE_CANDIDATE", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate({ selected_at_utc: "2026-07-01T00:00:00.000Z" }));
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshGo,
    });
    expect(result.blocker).toBe("BLOCKED_STALE_CANDIDATE");
    expectNoPayment(result);
  });

  it("allows human review when selection requirements expired but requires pay-time refresh", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate({}, "2026-07-05T00:00:00.000Z"));
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshGo,
    });
    expect(result.ok).toBe(true);
    expect(result.selection_requirements_currently_expired).toBe(true);
    expect(result.fresh_unsigned_402_required_before_signing).toBe(true);
    expectNoPayment(result);
  });

  it("fails closed on a legacy selected_candidate without persisted requirements", async () => {
    const runDir = makeRunDir();
    const candidate = mainnetCandidate();
    const { schema_version: _schema, seller_requirements: _requirements, ...legacy } = candidate;
    writeCandidate(runDir, legacy);
    const reader = vi.fn(readerReturning(8453));
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: reader,
      freshness: freshGo,
    });
    expect(result.blocker).toBe("REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED");
    expect(reader).not.toHaveBeenCalled();
    expectNoPayment(result);
  });

  it("blocks a selected candidate that already contains signed-buyer material", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, {
      ...mainnetCandidate(),
      buyer_signed_authorization: { nonce: "forbidden", signature: "0xforbidden" },
    });
    const reader = vi.fn(readerReturning(8453));
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: reader,
      freshness: freshGo,
    });
    expect(result.blocker).toBe("BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID");
    expect(reader).not.toHaveBeenCalled();
    expectNoPayment(result);
  });

  it("already-consumed run blocks with BLOCKED_RUN_ALREADY_CONSUMED", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    writeFileSync(join(runDir, "settlement_intent_attempt_x.json"), "{}\n", "utf8");
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshGo,
    });
    expect(result.blocker).toBe("BLOCKED_RUN_ALREADY_CONSUMED");
    expect(result.run_already_consumed).toBe(true);
    expectNoPayment(result);
  });

  it("RPC timeout blocks with BLOCKED_RPC_TIMEOUT", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {},
      now: NOW,
      chainStateReader: timeoutReader,
      freshness: freshGo,
    });
    expect(result.blocker).toBe("BLOCKED_RPC_TIMEOUT");
    expectNoPayment(result);
  });

  it("no explicitly configured fallback still times out closed (no silent fallback)", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: {}, // TRUSTFORGE_BASE_RPC_FALLBACK_URLS unset
      now: NOW,
      chainStateReader: timeoutReader,
      freshness: freshGo,
    });
    expect(result.rpc_fallback_configured).toBe(false);
    expect(result.rpc_silent_fallback).toBe(false);
    expect(result.blocker).toBe("BLOCKED_RPC_TIMEOUT");
    expectNoPayment(result);
  });

  it("Sepolia key present on mainnet blocks with BLOCKED_OPPOSITE_NETWORK_KEY", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      env: { SEPOLIA_BUYER_PRIVATE_KEY: `0x${"1".repeat(64)}` },
      now: NOW,
      chainStateReader: readerReturning(8453),
      freshness: freshGo,
    });
    expect(result.blocker).toBe("BLOCKED_OPPOSITE_NETWORK_KEY");
    expect(result.sepolia_buyer_private_key_present).toBe(true);
    expectNoPayment(result);
  });
});

describe("x402 settlement preflight — optional --verify-wallet-env human gate", () => {
  it("wrong wallet blocks with BLOCKED_WRONG_WALLET and never signs", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      verifyWalletEnv: true,
      env: { BUYER_PRIVATE_KEY: HARDHAT_TEST_KEY_1 },
      now: NOW,
    });
    expect(result.mode).toBe("verify-wallet-env");
    expect(result.blocker).toBe("BLOCKED_WRONG_WALLET");
    expect(result.buyer_derived?.toLowerCase()).toBe(HARDHAT_ADDR_1.toLowerCase());
    expectNoPayment(result);
  });

  it("Sepolia key present refuses the mainnet wallet gate with BLOCKED_OPPOSITE_NETWORK_KEY", async () => {
    const runDir = makeRunDir();
    writeCandidate(runDir, mainnetCandidate());
    const result = await runX402SettlementPreflight({
      runDir,
      network: "mainnet",
      verifyWalletEnv: true,
      env: { SEPOLIA_BUYER_PRIVATE_KEY: `0x${"1".repeat(64)}` },
      now: NOW,
    });
    expect(result.blocker).toBe("BLOCKED_OPPOSITE_NETWORK_KEY");
    expectNoPayment(result);
  });
});
