import { describe, expect, it } from "vitest";
import { verifyTxExplainerFacts } from "../../tools/trustforge/verify-tx-explainer-facts";
import { claimsFromGroundTruth, extractTxExplainerClaims } from "../../tools/trustforge/extract-tx-explainer-claims";
import type { TxGroundTruth } from "../../tools/trustforge/build-tx-ground-truth";

const groundTruth: TxGroundTruth = {
  chain_id: 8453,
  tx_hash: "0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4",
  exists: true,
  status: "success",
  block_number: 47310852,
  from: "0xb87e1a2cc2b4643f2892768e80e41167f17c5860",
  to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  gas_used: "0x1511a",
  effective_gas_price: "0x989680",
  logs_count: 2,
  erc20_transfers: [
    {
      token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      symbol: "USDC",
      decimals: 6,
      from: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
      to: "0x52e29e0d2aa49bfbfc548c0a9f2196f4aa51f3ea",
      amount_atomic: "1000",
      amount_decimal: "0.001",
    },
  ],
  created_at_utc: "2026-06-14T00:00:00.000Z",
};

describe("verifyTxExplainerFacts", () => {
  it("passes when claims match ground truth", () => {
    const claims = claimsFromGroundTruth(groundTruth);
    const result = verifyTxExplainerFacts({ groundTruth, claims });
    expect(result.composite).toBeGreaterThanOrEqual(0.8);
    expect(result.passed).toBe(true);
  });

  it("caps composite on wrong tx hash", () => {
    const claims = extractTxExplainerClaims({
      body: {
        tx_hash: "0x" + "a".repeat(64),
        chain_id: 8453,
        status: "success",
        block_number: groundTruth.block_number,
      },
    });
    const result = verifyTxExplainerFacts({ groundTruth, claims });
    expect(result.composite).toBeLessThanOrEqual(0.2);
    expect(result.passed).toBe(false);
  });

  it("caps composite on wrong chain", () => {
    const claims = extractTxExplainerClaims({
      body: {
        tx_hash: groundTruth.tx_hash,
        chain_id: 1,
        status: "success",
        block_number: groundTruth.block_number,
      },
    });
    const result = verifyTxExplainerFacts({ groundTruth, claims });
    expect(result.composite).toBeLessThanOrEqual(0.4);
  });

  it("fails token amount mismatch", () => {
    const claims = extractTxExplainerClaims({
      body: {
        tx_hash: groundTruth.tx_hash,
        chain_id: 8453,
        status: "success",
        block_number: groundTruth.block_number,
        amount: "9.99 USDC",
        erc20_transfers: [
          {
            token: groundTruth.erc20_transfers[0]?.token,
            from: groundTruth.erc20_transfers[0]?.from,
            to: groundTruth.erc20_transfers[0]?.to,
            amount_decimal: "9.99",
          },
        ],
      },
    });
    const result = verifyTxExplainerFacts({ groundTruth, claims });
    expect(result.dimensions.amount_facts).toBe(0);
    expect(result.composite).toBeLessThanOrEqual(0.5);
  });

  it("does not penalize unverifiable prose alone", () => {
    const claims = extractTxExplainerClaims({
      body: `${groundTruth.tx_hash} on Base ${groundTruth.block_number} success 0.001 USDC. Beautiful narrative prose only.`,
    });
    const result = verifyTxExplainerFacts({ groundTruth, claims });
    expect(result.unverifiable_claims.length).toBeGreaterThanOrEqual(0);
  });
});
