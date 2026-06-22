import { describe, expect, it } from "vitest";
import { validateLedgerIdentity } from "../../tools/trustforge/ledger-reuse-validation";
import { TESTNET_NETWORK, TESTNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { SEPOLIA_TESTNET_BUYER_WALLET } from "../../tools/trustforge/network-config";

const EXPECTED = {
  network: TESTNET_NETWORK,
  chainId: 84532,
  buyer: SEPOLIA_TESTNET_BUYER_WALLET,
  asset: TESTNET_USDC_ADDRESS,
};

const BASE_LEDGER = {
  schema_name: "trustforge_onchain_settlement_ledger",
  schema_version: "0.2.0",
  chain: TESTNET_NETWORK,
  chain_id: 84532,
  wallet: SEPOLIA_TESTNET_BUYER_WALLET,
  usdc_contract: TESTNET_USDC_ADDRESS,
  scanned_to_block: 43159860,
  settlements: [],
};

describe("ledger-reuse-validation", () => {
  it("passes exact identity", () => {
    expect(validateLedgerIdentity(BASE_LEDGER, EXPECTED).ok).toBe(true);
  });

  it("refuses wrong wallet", () => {
    const result = validateLedgerIdentity(
      { ...BASE_LEDGER, wallet: "0x0000000000000000000000000000000000000001" },
      EXPECTED,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("REUSE_LEDGER_IDENTITY_MISMATCH");
  });

  it("refuses wrong chain", () => {
    const result = validateLedgerIdentity({ ...BASE_LEDGER, chain_id: 8453 }, EXPECTED);
    expect(result.ok).toBe(false);
  });

  it("refuses wrong asset", () => {
    const result = validateLedgerIdentity(
      { ...BASE_LEDGER, usdc_contract: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
      EXPECTED,
    );
    expect(result.ok).toBe(false);
  });

  it("refuses unsupported schema", () => {
    const result = validateLedgerIdentity({ ...BASE_LEDGER, schema_name: "other" }, EXPECTED);
    expect(result.ok).toBe(false);
  });
});
