import { describe, expect, it, vi } from "vitest";

import { adaptDiscoveredPrimaryToSelectedCandidate, adaptDiscoveredPrimaryToThinSettlementCandidate } from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  classifySepoliaSettlement,
  confirmSepoliaSettlementBinding,
  parseReconciliationLedger,
} from "../../tools/trustforge/sepolia-settlement-classify";
import { buildSettlementIntent } from "../../tools/trustforge/settlement-run-binding";
import {
  buildSepoliaTargetSelectionFromHandshake,
  parseSepoliaSeller402Response,
} from "../../tools/trustforge/sepolia-seller-handshake";
import {
  assertMainnetBuyerKeyAbsent,
  assertSepoliaNetwork,
  preSignSepoliaGuards,
} from "../../tools/trustforge/sepolia-settlement-guards";
import { validateHumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import { evaluateFresh402AgainstAuthorizedQuote } from "../../tools/trustforge/paid-quote-freshness-preflight";
import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  PAYMENT_AMOUNT_ATOMIC,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import { SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";

function requestFields(endpoint: string, method: "GET" | "POST", body: unknown = {}) {
  const binding = createThinSettlementRequestBinding({
    endpoint,
    method,
    input_status: "known",
    query: [],
    body: method === "GET" ? null : body,
  });
  return {
    method,
    requestEndpoint: binding.endpoint,
    requestInputStatus: "known" as const,
    requestQuery: binding.query,
    requestBody: binding.body,
    requestInputProvenance: "policy_generated_request_binding" as const,
    requestBindingSha256: binding.binding_sha256,
  };
}

describe("Sepolia settlement proof pipeline", () => {
  it("builds target_selection from seller 402 handshake", () => {
    const handshake = parseSepoliaSeller402Response({
      sellerBaseUrl: "http://localhost:4021",
      statusCode: 402,
      paymentRequiredHeader: Buffer.from(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: TESTNET_NETWORK,
              asset: TESTNET_USDC_ADDRESS,
              amount: PAYMENT_AMOUNT_ATOMIC,
              payTo: SEPOLIA_TESTNET_BUYER_WALLET,
            },
          ],
        }),
      ).toString("base64"),
    });
    const doc = buildSepoliaTargetSelectionFromHandshake(handshake);
    expect(doc.network).toBe(TESTNET_NETWORK);
    expect(doc.selection.primary.handshakeStatus).toBe("live_402_ok");
  });

  it("adapts Sepolia local seller to selected_candidate", () => {
    const adapted = adaptDiscoveredPrimaryToSelectedCandidate({
      selection: {
        primary: {
          handshakeStatus: "live_402_ok",
          resourceUrl: "http://localhost:4021/paid/analyze-text",
          ...requestFields("http://localhost:4021/paid/analyze-text", "POST", {
            text: "TrustForge Sepolia settlement proof handshake.",
            mode: "full",
          }),
          quoteUsdc: "0.001",
          quoteAtomic: "1000",
          selectedPayTo: SEPOLIA_TESTNET_BUYER_WALLET,
          network: TESTNET_NETWORK,
          asset: TESTNET_USDC_ADDRESS,
          scoringRationale: ["local sepolia seller"],
        },
        fallbacks: [],
      },
    });
    expect(adapted.ok).toBe(true);
    if (adapted.ok) {
      expect(adapted.candidate.network).toBe(TESTNET_NETWORK);
      expect(adapted.candidate.buyer_wallet).toBe(SEPOLIA_TESTNET_BUYER_WALLET);
    }
  });

  it("adapts discovered primary to thin candidate without rich allowlist", () => {
    const adapted = adaptDiscoveredPrimaryToThinSettlementCandidate({
      selection: {
        primary: {
          handshakeStatus: "live_402_ok",
          resourceUrl: "https://api.zapper.xyz/v2/x402/token-balances",
          ...requestFields("https://api.zapper.xyz/v2/x402/token-balances", "GET"),
          quoteUsdc: "0.001125",
          quoteAtomic: "1125",
          selectedPayTo: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          scoringRationale: ["fresh discovery primary"],
        },
        fallbacks: [],
      },
    });
    expect(adapted.ok).toBe(true);
    if (adapted.ok) {
      expect(adapted.candidate.endpoint).toBe("https://api.zapper.xyz/v2/x402/token-balances");
      expect(adapted.candidate.network).toBe(MAINNET_NETWORK);
    }
  });

  it("rich adapt still rejects non-allowlisted endpoint", () => {
    const adapted = adaptDiscoveredPrimaryToSelectedCandidate({
      selection: {
        primary: {
          handshakeStatus: "live_402_ok",
          resourceUrl: "https://api.zapper.xyz/v2/x402/token-balances",
          quoteUsdc: "0.001125",
          quoteAtomic: "1125",
          selectedPayTo: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
          network: MAINNET_NETWORK,
          scoringRationale: ["fresh discovery primary"],
        },
        fallbacks: [],
      },
    });
    expect(adapted.ok).toBe(false);
  });

  it("requires network 84532 on testnet authorization", () => {
    const selected = {
      provider: "TrustForgeLocalSeller",
      service_id: "local_analyze_text",
      endpoint: "http://localhost:4021/paid/analyze-text",
      network: TESTNET_NETWORK,
      buyer_wallet: SEPOLIA_TESTNET_BUYER_WALLET,
    };
    const bad = validateHumanPaymentAuthorization(
      {
        authorization_schema_version: "trustforge_paid_probe_authorization.v1",
        decision: "authorize_one_payment",
        provider: selected.provider,
        service_id: selected.service_id,
        endpoint: selected.endpoint,
        network: MAINNET_NETWORK,
        buyer_wallet: SEPOLIA_TESTNET_BUYER_WALLET,
        max_usdc: "0.002",
        max_payment_attempts: 1,
        allow_retry: false,
        require_dedicated_wallet: true,
        decided_at: "2026-06-21T00:00:00Z",
        rationale: "test",
      },
      selected,
    );
    expect(bad.valid).toBe(false);
  });

  it("freshness accepts Sepolia network params", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      {
        status: "live_402_ok",
        quoteAtomic: "1000",
        quoteUsdc: "0.001",
        selectedAccept: {
          scheme: "exact",
          network: TESTNET_NETWORK,
          asset: TESTNET_USDC_ADDRESS,
          amountAtomic: "1000",
          payTo: SEPOLIA_TESTNET_BUYER_WALLET,
        },
        challenge: { expiresAt: new Date(Date.now() + 60_000).toISOString(), nonce: "n1" },
      },
      {
        endpoint: "http://localhost:4021/paid/analyze-text",
        quote_amount_usdc: "0.001",
        quote_atomic: "1000",
        authorized_max_usdc: "0.002",
        pay_to: SEPOLIA_TESTNET_BUYER_WALLET,
        network: TESTNET_NETWORK,
        asset: TESTNET_USDC_ADDRESS,
      },
    );
    expect(result.go).toBe(true);
  });

  it("refuses mainnet buyer key during Sepolia guards", () => {
    expect(() =>
      assertMainnetBuyerKeyAbsent({ BUYER_PRIVATE_KEY: "0x" + "11".repeat(32) }),
    ).toThrow(/BLOCKED_MAINNET_KEY_PRESENT/);
  });

  it("RPC unavailable is not settlement-not-found", () => {
    const outcome = classifySepoliaSettlement({
      probe: {
        paymentAttempted: false,
        paymentBearingHttpRequestCount: 0,
        httpStatus: null,
      },
      reconciliationUnavailable: true,
      reconciliationStatus: "RECONCILIATION_RPC_UNAVAILABLE",
    });
    expect(outcome.outcome).toBe("BLOCKED_RECONCILIATION_UNAVAILABLE");
  });

  it("classifies reconciled transfer as PASS_SETTLED", () => {
    const outcome = classifySepoliaSettlement({
      probe: {
        paymentAttempted: true,
        paymentBearingHttpRequestCount: 1,
        httpStatus: 200,
        onChainConfirmed: true,
        settlementTxHash: "0xabc",
        facilitatorReceiptPresent: true,
        facilitatorReceiptParseStatus: "parsed",
      },
      reconciliationStatus: "RECONCILIATION_PASS",
      safeToUseForPaymentVerification: true,
      unattributedSettlementsFound: 0,
      balanceIdentityStatus: "pass",
      noNewOutboundTransfer: false,
      binding: {
        attempt_id: "attempt_1",
        run_id: "run_1",
        authorization_hash: "hash",
        settlement_tx_hash: "0xabc",
        actual_spend_atomic: "1000",
        settlement_status: "confirmed",
        block_number: "1",
        matched_by: ["independent"],
        facilitator_hash_agrees: true,
        facilitator_hash_cross_check: "agree",
        facilitator_reported_hash: "0xabc",
        reconciler_found_hash: "0xabc",
        facilitator_receipt: {
          source: "payment-response-header",
          parse_status: "parsed",
          transaction_hash: "0xabc",
        },
        independent_match: {
          settlement_tx_hash: "0xabc",
          block_number: 1,
          timestamp_utc: "2026-06-21T00:00:00.000Z",
          actual_spend_atomic: "1000",
        },
        current_attempt_candidates_after_filter: 1,
        rejected_candidates: [],
        detail: "confirmed",
      },
    });
    expect(outcome.outcome).toBe("PASS_SETTLED");
  });

  it("parseReconciliationLedger detects Sepolia proof hash", () => {
    const parsed = parseReconciliationLedger({
      reconciliation_status: "RECONCILIATION_PASS",
      safe_to_use_for_payment_verification: true,
      unattributed_settlements_found: 0,
      balance_identity_status: "pass",
      settlements: [{ tx_hash: "0xdead", matched_run: "thin_settlement_proof" }],
    });
    expect(parsed.settlementTxHash).toBe("0xdead");
  });

  it("binding metrics reach 1/1 when independent match agrees with facilitator hash", () => {
    const intent = buildSettlementIntent({
      attemptId: "attempt_1",
      runId: "run_1",
      authorizationHash: "hash",
      network: TESTNET_NETWORK,
      buyer: SEPOLIA_TESTNET_BUYER_WALLET,
      payTo: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
      asset: TESTNET_USDC_ADDRESS,
      amountAtomic: "1000",
      now: new Date("2026-06-21T04:53:46.000Z"),
    });
    const ledger = {
      reconciliation_status: "RECONCILIATION_PASS",
      safe_to_use_for_payment_verification: true,
      unattributed_settlements_found: 0,
      balance_identity_status: "pass",
      settlements: [
        {
          tx_hash: "0xb3329fecc3ec9e5470f21d9c255475c7d8acb2f596aaa7fcf1c18fd579c4e99b",
          to: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
          value_atomic: "1000",
          timestamp_utc: "2026-06-21T04:54:00.000Z",
        },
      ],
    };
    const { binding, metrics } = confirmSepoliaSettlementBinding({
      intent,
      ledger,
      facilitatorReportedHash:
        "0xb3329fecc3ec9e5470f21d9c255475c7d8acb2f596aaa7fcf1c18fd579c4e99b",
      upperBoundUtc: "2026-06-21T05:00:00.000Z",
    });
    expect(binding.settlement_status).toBe("confirmed");
    expect(metrics.total_outflow_settlements_found).toBe(1);
    expect(metrics.phase6_settlements_identified).toBe(1);
    expect(metrics.unattributed_settlements_found).toBe(0);
  });
});

describe("preSignSepoliaGuards", () => {
  it("refuses wrong testnet wallet", () => {
    expect(() =>
      preSignSepoliaGuards({
        privateKey: "0x" + "22".repeat(32),
        network: TESTNET_NETWORK,
        chainId: 84532,
      }),
    ).toThrow(/BLOCKED_WRONG_TESTNET_WALLET/);
  });
});

describe("assertSepoliaNetwork", () => {
  it("hard-refuses mainnet caip2", () => {
    expect(() => assertSepoliaNetwork(MAINNET_NETWORK)).toThrow(/BLOCKED_MAINNET_SIGNAL/);
  });
});
