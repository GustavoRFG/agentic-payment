import { describe, expect, it } from "vitest";
import {
  mapRichPaymentAttempts,
  summarizeSavedRichRun,
} from "../../tools/trustforge/map-rich-payment-attempts";
import {
  reconcileUsdcSettlements,
  type UsdcSettlementReconciliation,
} from "../../tools/trustforge/reconcile-usdc-settlements";
import { resolveSettlementEvidence, legacySettlementEvidenceView } from "../../tools/trustforge/settlement-evidence";
import { checkPhase3bEnvSafety } from "../../tools/run-trustforge-rich-tx-explainer-phase3b";

const WALLET = "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1";

function mockFetch(logs: unknown[], blockTimestamp = "0x684c5a80"): typeof fetch {
  return (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { method: string; params: unknown[] };
    if (body.method === "eth_getLogs") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: logs }), { status: 200 });
    }
    if (body.method === "eth_getBlockByNumber") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { timestamp: blockTimestamp } }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected rpc method ${body.method}`);
  }) as typeof fetch;
}

describe("reconcileUsdcSettlements", () => {
  it("finds two Zapper 0.001125 USDC outbound transfers", async () => {
    const logs = [
      {
        transactionHash: "0x" + "a".repeat(64),
        blockNumber: "0x2d1b2f4",
        logIndex: "0x1",
        transactionIndex: "0x0",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x0000000000000000000000004cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
          "0x00000000000000000000000043a2a720cd0911690c248075f4a29a5e7716f758",
        ],
        data: "0x0000000000000000000000000000000000000000000000000000000000000465",
      },
      {
        transactionHash: "0x" + "b".repeat(64),
        blockNumber: "0x2d1b2f5",
        logIndex: "0x2",
        transactionIndex: "0x1",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x0000000000000000000000004cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
          "0x00000000000000000000000043a2a720cd0911690c248075f4a29a5e7716f758",
        ],
        data: "0x0000000000000000000000000000000000000000000000000000000000000465",
      },
      {
        transactionHash: "0x" + "c".repeat(64),
        blockNumber: "0x2d1b2f6",
        logIndex: "0x3",
        transactionIndex: "0x2",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
          "0x0000000000000000000000004cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
          "0x00000000000000000000000052e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
        ],
        data: "0x00000000000000000000000000000000000000000000000000000000000003e8",
      },
    ];

    const reconciliation = await reconcileUsdcSettlements({
      wallet: WALLET,
      fromBlock: 47_310_000,
      fetchImpl: mockFetch(logs),
    });

    expect(reconciliation.settlement_reconciliation_status).toBe(
      "SETTLEMENT_FOUND_BY_CHAIN_RECONCILIATION",
    );
    expect(reconciliation.zapper_candidate_count).toBe(2);
    expect(reconciliation.reconciled_total_usdc).toBe("0.00225");
  });
});

describe("mapRichPaymentAttempts", () => {
  it("maps three attempts to two settlements with one unmapped attempt", () => {
    const reconciliation = {
      events: [
        {
          tx_hash: "0x" + "a".repeat(64),
          block_number: 1,
          block_timestamp_utc: null,
          from: WALLET,
          to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
          amount_atomic: "1125",
          amount_decimal: "0.001125",
          log_index: 0,
          transaction_index: 0,
          candidate_match: "zapper_rich_tx_explainer" as const,
        },
        {
          tx_hash: "0x" + "b".repeat(64),
          block_number: 2,
          block_timestamp_utc: null,
          from: WALLET,
          to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
          amount_atomic: "1125",
          amount_decimal: "0.001125",
          log_index: 0,
          transaction_index: 0,
          candidate_match: "zapper_rich_tx_explainer" as const,
        },
      ],
    } as UsdcSettlementReconciliation;

    const runs = [
      summarizeSavedRichRun("run_20260614_214953", {
        payment: { payment_bearing_http_request_count: 1, transaction_hash: null },
        seller_response: { body_sha256: "1674d473" },
        created_at_utc: "2026-06-14T21:49:56.691Z",
      }),
      summarizeSavedRichRun("run_20260614_215030", {
        payment: { payment_bearing_http_request_count: 1, transaction_hash: null },
        seller_response: { body_sha256: "1674d473" },
        created_at_utc: "2026-06-14T21:50:30.000Z",
      }),
      summarizeSavedRichRun("run_20260614_215039", {
        payment: { payment_bearing_http_request_count: 1, transaction_hash: null },
        seller_response: { body_sha256: "1674d473" },
        created_at_utc: "2026-06-14T21:50:39.000Z",
      }),
    ];

    const mapping = mapRichPaymentAttempts({ runs, reconciliation });
    expect(mapping.attempts[0]?.mapped_settlement_tx_hash).toBe("0x" + "a".repeat(64));
    expect(mapping.attempts[2]?.mapped_settlement_tx_hash).toBeNull();
    expect(mapping.unmapped_attempts).toContain("run_20260614_215039");
    expect(mapping.attempt_mapping_status).toBe("AMBIGUOUS");
  });
});

describe("settlement evidence semantics", () => {
  it("keeps actual_spend_usdc null without mapped reconciliation", () => {
    const evidence = resolveSettlementEvidence({
      paymentAttempted: true,
      savedTransactionHash: null,
      paymentResponseHeaderPresent: false,
      quoteUsdc: "0.001125",
    });
    expect(evidence.status).toBe("missing_payment_metadata");
    expect(legacySettlementEvidenceView(evidence).actual_spend_usdc).toBeNull();
  });

  it("uses chain reconciliation when mapped with medium confidence", () => {
    const evidence = resolveSettlementEvidence({
      paymentAttempted: true,
      reconciledTxHash: "0x" + "a".repeat(64),
      reconciledAmountUsdc: "0.001125",
      mappingConfidence: "medium",
      quoteUsdc: "0.001125",
    });
    expect(evidence.status).toBe("chain_reconciled");
    expect(evidence.amountDecimal).toBe("0.001125");
    expect(evidence.transactionHashSource).toBe("chain_reconciliation");
    expect(legacySettlementEvidenceView(evidence).actual_spend_usdc).toBe("0.001125");
  });
});

describe("phase3b safety", () => {
  it("blocks when payment env flags are armed", () => {
    const safety = checkPhase3bEnvSafety({
      BUYER_PRIVATE_KEY: "0x" + "1".repeat(64),
      TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID: "YES",
    });
    expect(safety.status).toBe("BLOCKED_WALLET_LOAD_ATTEMPT");
  });

  it("passes with no payment flags", () => {
    expect(checkPhase3bEnvSafety({}).status).toBe("PASS_NO_PAYMENT_FLAGS");
  });
});
