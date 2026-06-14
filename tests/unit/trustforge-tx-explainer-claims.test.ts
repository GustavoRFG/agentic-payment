import { describe, expect, it } from "vitest";
import {
  claimsFromGroundTruth,
  extractTxExplainerClaims,
} from "../../tools/trustforge/extract-tx-explainer-claims";
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

describe("extractTxExplainerClaims", () => {
  it("extracts claims from JSON structured response", () => {
    const claims = extractTxExplainerClaims({
      body: {
        tx_hash: groundTruth.tx_hash,
        chain_id: 8453,
        status: "success",
        block_number: groundTruth.block_number,
        erc20_transfers: groundTruth.erc20_transfers,
      },
    });
    expect(claims.tx_hash_claims).toContain(groundTruth.tx_hash);
    expect(claims.chain_claims).toContain("8453");
    expect(claims.amount_claims).toContain("0.001");
  });

  it("extracts claims from prose without penalty fields", () => {
    const claims = extractTxExplainerClaims({
      body: `Transaction ${groundTruth.tx_hash} on Base chain 8453 succeeded in block ${groundTruth.block_number}.`,
    });
    expect(claims.tx_hash_claims[0]).toBe(groundTruth.tx_hash);
    expect(claims.chain_claims).toContain("8453");
  });

  it("allows category inspiration style prose for storex-like text", () => {
    const claims = extractTxExplainerClaims({
      body:
        "Category-level storage products on Base; no specific ASIN referenced.",
    });
    expect(claims.unsupported_claims).toEqual([]);
    expect(claims.raw_claim_count).toBeGreaterThanOrEqual(0);
  });

  it("ground truth roundtrip produces matching claims", () => {
    const claims = claimsFromGroundTruth(groundTruth);
    expect(claims.tx_hash_claims).toContain(groundTruth.tx_hash);
  });
});
