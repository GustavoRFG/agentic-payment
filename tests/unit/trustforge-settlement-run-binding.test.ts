import { describe, expect, it } from "vitest";
import {
  buildSettlementIntent,
  bindingConfirmsSettlement,
  confirmSettlementBinding,
  countIdentifiedSettlements,
  evaluateTimeWindow,
  findEligibleSettlementCandidates,
  CLOCK_SKEW_TOLERANCE_MS,
} from "../../tools/trustforge/settlement-run-binding";
import { TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";

const PAY_TO = "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71";
const OLD_TX = "0xb3329fecc3ec9e5470f21d9c255475c7d8acb2f596aaa7fcf1c18fd579c4e99b";
const NEW_TX = "0x9ce1e957b4547ee86559e8b32af4a9a6e7087f8330096fde618abe4ea9ccf9a9";
const INTENT_START = "2026-06-22T00:26:14.368Z";
const EXECUTION_END = "2026-06-22T00:30:00.000Z";

function phase62Intent() {
  return buildSettlementIntent({
    attemptId: "attempt_8e1a854c-c841-47b9-937c-5549857484a5",
    runId: "run_20260621_212429",
    authorizationHash: "a6ab2d6b518734e807515e99fb816c1c6669759a1f030693b6ec87cc4d6a1a03",
    network: TESTNET_NETWORK,
    buyer: SEPOLIA_TESTNET_BUYER_WALLET,
    payTo: PAY_TO,
    asset: TESTNET_USDC_ADDRESS,
    amountAtomic: "1000",
    now: new Date(INTENT_START),
  });
}

const historicalTransfer = {
  tx_hash: OLD_TX,
  to: PAY_TO,
  value_atomic: "1000",
  block_number: 43127024,
  timestamp_utc: "2026-06-21T06:12:16+00:00",
};

const currentTransfer = {
  tx_hash: NEW_TX,
  to: PAY_TO,
  value_atomic: "1000",
  block_number: 43159850,
  timestamp_utc: "2026-06-22T00:26:28+00:00",
};

describe("settlement-run-binding temporal repair", () => {
  it("6.1 selects current transfer and rejects historical before_intent_window", () => {
    const intent = phase62Intent();
    const { eligible, rejected } = findEligibleSettlementCandidates({
      intent,
      settlements: [historicalTransfer, currentTransfer],
      upperBoundUtc: EXECUTION_END,
    });
    expect(eligible).toHaveLength(1);
    expect(eligible[0].candidate.txHash).toBe(NEW_TX.toLowerCase());
    expect(eligible[0].candidate.blockNumber).toBe(43159850);
    expect(eligible[0].matchedBy).toContain("time_window");
    expect(rejected.some((row) => row.tx_hash.toLowerCase() === OLD_TX.toLowerCase())).toBe(true);
    expect(rejected.find((row) => row.tx_hash.toLowerCase() === OLD_TX.toLowerCase())?.rejected_reason).toBe(
      "before_intent_window",
    );
  });

  it("6.2 historical transfer only yields settlement_not_found", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [historicalTransfer],
      facilitatorReportedHash: null,
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.settlement_status).toBe("settlement_not_found");
    expect(bindingConfirmsSettlement(binding)).toBe(false);
    expect(binding.facilitator_hash_agrees).toBeNull();
    expect(countIdentifiedSettlements([historicalTransfer], binding)).toBe(0);
  });

  it("6.3 explicit time-boundary behavior with CLOCK_SKEW_TOLERANCE_MS", () => {
    const requestStartedMs = Date.parse(INTENT_START);
    const upperBoundMs = Date.parse(EXECUTION_END);
    expect(
      evaluateTimeWindow({
        timestampUtc: new Date(requestStartedMs - 119_000).toISOString(),
        requestStartedMs,
        upperBoundMs,
      }).inWindow,
    ).toBe(true);
    expect(
      evaluateTimeWindow({
        timestampUtc: new Date(requestStartedMs - 121_000).toISOString(),
        requestStartedMs,
        upperBoundMs,
      }).inWindow,
    ).toBe(false);
    expect(
      evaluateTimeWindow({
        timestampUtc: INTENT_START,
        requestStartedMs,
        upperBoundMs,
      }).inWindow,
    ).toBe(true);
    expect(
      evaluateTimeWindow({
        timestampUtc: null,
        requestStartedMs,
        upperBoundMs,
      }).inWindow,
    ).toBe(false);
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(120_000);
  });

  it("6.4 multiple valid current-window candidates yields ambiguous_match", () => {
    const secondCurrent = {
      ...currentTransfer,
      tx_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      block_number: 43159851,
      timestamp_utc: "2026-06-22T00:26:29+00:00",
    };
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [currentTransfer, secondCurrent],
      facilitatorReportedHash: NEW_TX,
      upperBoundUtc: "2026-06-22T00:27:00.000Z",
    });
    expect(binding.settlement_status).toBe("ambiguous_match");
    expect(binding.current_attempt_candidates_after_filter).toBe(2);
    expect(bindingConfirmsSettlement(binding)).toBe(false);
  });

  it("6.5 missing facilitator receipt is not agreement", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [historicalTransfer, currentTransfer],
      facilitatorReceipt: {
        parseStatus: "missing",
        source: "none",
        rawHeaderName: null,
        transactionHash: null,
        network: null,
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: null,
      },
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.settlement_status).toBe("facilitator_receipt_missing");
    expect(binding.facilitator_hash_cross_check).toBe("missing");
    expect(binding.facilitator_hash_agrees).toBeNull();
    expect(binding.settlement_tx_hash).toBe(NEW_TX.toLowerCase());
    expect(bindingConfirmsSettlement(binding)).toBe(false);
  });

  it("6.5b parsed receipt without hash is facilitator_hash_missing", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [currentTransfer],
      facilitatorReceipt: {
        parseStatus: "parsed",
        source: "payment-response-header",
        rawHeaderName: "payment-response",
        transactionHash: null,
        network: "eip155:84532",
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: "MISSING_TX_HASH_FIELD",
      },
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.settlement_status).toBe("facilitator_hash_missing");
  });

  it("6.5c malformed receipt is not agreement", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [currentTransfer],
      facilitatorReceipt: {
        parseStatus: "malformed",
        source: "payment-response-header",
        rawHeaderName: "payment-response",
        transactionHash: null,
        network: null,
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: "INVALID_BASE64_JSON",
      },
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.settlement_status).toBe("facilitator_receipt_malformed");
    expect(bindingConfirmsSettlement(binding)).toBe(false);
  });

  it("6.6 facilitator hash mismatch is not confirmed", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [currentTransfer],
      facilitatorReceipt: {
        parseStatus: "parsed",
        source: "payment-response-header",
        rawHeaderName: "payment-response",
        transactionHash: OLD_TX.toLowerCase() as `0x${string}`,
        network: "eip155:84532",
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: null,
      },
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.settlement_status).toBe("hash_mismatch");
    expect(binding.facilitator_hash_agrees).toBe(false);
    expect(bindingConfirmsSettlement(binding)).toBe(false);
  });

  it("6.7 facilitator hash agreement confirms binding", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [currentTransfer],
      facilitatorReceipt: {
        parseStatus: "parsed",
        source: "payment-response-header",
        rawHeaderName: "payment-response",
        transactionHash: NEW_TX.toLowerCase() as `0x${string}`,
        network: "eip155:84532",
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: null,
      },
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.settlement_status).toBe("confirmed");
    expect(binding.facilitator_hash_cross_check).toBe("agree");
    expect(binding.facilitator_hash_agrees).toBe(true);
    expect(binding.matched_by).toEqual([
      "network",
      "buyer",
      "pay_to",
      "amount",
      "asset",
      "time_window",
    ]);
    expect(bindingConfirmsSettlement(binding)).toBe(true);
  });

  it("6.8 final hash comes from current attempt binding only", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [historicalTransfer, currentTransfer],
      facilitatorReceipt: {
        parseStatus: "missing",
        source: "none",
        rawHeaderName: null,
        transactionHash: null,
        network: null,
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: null,
      },
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.attempt_id).toBe("attempt_8e1a854c-c841-47b9-937c-5549857484a5");
    expect(binding.settlement_tx_hash).toBe(NEW_TX.toLowerCase());
    expect(binding.settlement_tx_hash).not.toBe(OLD_TX.toLowerCase());
  });

  it("6.9 matched_by is truthful for historical transfer", () => {
    const { rejected } = findEligibleSettlementCandidates({
      intent: phase62Intent(),
      settlements: [historicalTransfer],
      upperBoundUtc: EXECUTION_END,
    });
    const old = rejected.find((row) => row.tx_hash.toLowerCase() === OLD_TX.toLowerCase());
    expect(old?.rejected_reason).toBe("before_intent_window");
  });

  it("6.11 normalizes ledger hash field aliases", () => {
    const binding = confirmSettlementBinding({
      intent: phase62Intent(),
      settlements: [
        {
          transaction_hash: NEW_TX,
          pay_to: PAY_TO,
          amount_atomic: "1000",
          blockNumber: 43159850,
          timestampUtc: "2026-06-22T00:26:28+00:00",
        },
      ],
      facilitatorReportedHash: NEW_TX,
      upperBoundUtc: EXECUTION_END,
    });
    expect(binding.settlement_status).toBe("confirmed");
  });
});
