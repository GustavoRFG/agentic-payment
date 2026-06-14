import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractTxExplainerClaims } from "../../tools/trustforge/extract-tx-explainer-claims";
import { verifyTxExplainerFacts } from "../../tools/trustforge/verify-tx-explainer-facts";
import type { TxGroundTruth } from "../../tools/trustforge/build-tx-ground-truth";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const zapperBody = JSON.parse(
  readFileSync(
    join(repoRoot, "trustforge", "fixtures", "rich_tx_explainer", "zapper_seller_response.sample.json"),
    "utf8",
  ),
).body;

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

describe("Zapper rich tx explainer saved response", () => {
  it("does not treat gas metadata integers as USDC amount claims", () => {
    const claims = extractTxExplainerClaims({
      body: zapperBody,
      expectedChainId: 8453,
    });
    expect(claims.amount_claims).toEqual([]);
    expect(claims.tx_hash_claims[0]).toBe(groundTruth.tx_hash);
    expect(claims.block_number_claims).toContain(groundTruth.block_number);
    expect(claims.chain_claims).toContain("8453");
    expect(claims.token_transfer_claims.length).toBeGreaterThan(0);
  });

  it("marks saved Zapper response incomplete rather than factually wrong", () => {
    const claims = extractTxExplainerClaims({
      body: zapperBody,
      expectedChainId: 8453,
    });
    const facts = verifyTxExplainerFacts({ groundTruth, claims });
    expect(facts.wrong_claims).toEqual([]);
    expect(facts.missing_core_facts).toContain("status");
    expect(facts.missing_core_facts).toContain("amount");
    expect(facts.composite).toBeGreaterThan(0.7);
    expect(facts.passed).toBe(false);
  });
});
