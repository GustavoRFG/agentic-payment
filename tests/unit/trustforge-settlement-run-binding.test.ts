import { describe, expect, it } from "vitest";
import {
  buildSettlementIntent,
  confirmSettlementBinding,
  bindingConfirmsSettlement,
  countIdentifiedSettlements,
} from "../../tools/trustforge/settlement-run-binding";
import { TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";

describe("settlement-run-binding", () => {
  const intent = buildSettlementIntent({
    attemptId: "attempt_1",
    runId: "run_1",
    authorizationHash: "abc123",
    network: TESTNET_NETWORK,
    buyer: SEPOLIA_TESTNET_BUYER_WALLET,
    payTo: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
    asset: TESTNET_USDC_ADDRESS,
    amountAtomic: "1000",
    now: new Date("2026-06-21T04:53:46.000Z"),
  });

  const settlements = [
    {
      tx_hash: "0xb3329fecc3ec9e5470f21d9c255475c7d8acb2f596aaa7fcf1c18fd579c4e99b",
      to: "0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71",
      value_atomic: "1000",
      block_number: 12345,
      timestamp_utc: "2026-06-21T04:54:00.000Z",
    },
  ];

  it("confirms binding when independent match and facilitator hash agree", () => {
    const binding = confirmSettlementBinding({
      intent,
      settlements,
      facilitatorReportedHash:
        "0xb3329fecc3ec9e5470f21d9c255475c7d8acb2f596aaa7fcf1c18fd579c4e99b",
    });
    expect(binding.settlement_status).toBe("confirmed");
    expect(binding.facilitator_hash_agrees).toBe(true);
    expect(bindingConfirmsSettlement(binding)).toBe(true);
    expect(countIdentifiedSettlements(settlements, binding)).toBe(1);
  });

  it("flags hash mismatch when facilitator hash differs from reconciler", () => {
    const binding = confirmSettlementBinding({
      intent,
      settlements,
      facilitatorReportedHash: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    });
    expect(binding.settlement_status).toBe("hash_mismatch");
    expect(binding.facilitator_hash_agrees).toBe(false);
    expect(bindingConfirmsSettlement(binding)).toBe(false);
    expect(countIdentifiedSettlements(settlements, binding)).toBe(0);
  });

  it("persists intent fields for pre-call provenance", () => {
    expect(intent.authorization_hash).toBe("abc123");
    expect(intent.amount_atomic).toBe("1000");
    expect(intent.network).toBe(TESTNET_NETWORK);
  });
});
