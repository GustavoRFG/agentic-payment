import { describe, expect, it, vi } from "vitest";
import {
  assertSettlementNetworkGuards,
  assertOppositeNetworkKeyAbsent,
  expectedUsdcForNetwork,
} from "../../tools/trustforge/settlement-network-guards";
import {
  MAINNET_BUYER_WALLET,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_TESTNET_BUYER_WALLET,
} from "../../tools/trustforge/network-config";
import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";

const MAINNET_KEY = "0x" + "bb".repeat(32);
const SEPOLIA_KEY = "0x" + "aa".repeat(32);

describe("settlement-network-guards", () => {
  it("refuses opposite-network key present (Sepolia)", () => {
    expect(() =>
      assertOppositeNetworkKeyAbsent(SEPOLIA_BUYER_PRIVATE_KEY_ENV, {
        BUYER_PRIVATE_KEY: MAINNET_KEY,
        SEPOLIA_BUYER_PRIVATE_KEY: SEPOLIA_KEY,
      }),
    ).toThrow(/BLOCKED_CROSS_NETWORK_KEY/);
  });

  it("refuses wrong asset for Sepolia", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: TESTNET_NETWORK,
        privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
        expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
        asset: MAINNET_USDC_ADDRESS,
        env: { SEPOLIA_BUYER_PRIVATE_KEY: SEPOLIA_KEY },
      }),
    ).toThrow(/BLOCKED_WRONG_ASSET/);
  });

  it("refuses mainnet key env on Sepolia network", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: TESTNET_NETWORK,
        privateKeyEnvName: "BUYER_PRIVATE_KEY",
        expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
        asset: TESTNET_USDC_ADDRESS,
        env: { BUYER_PRIVATE_KEY: MAINNET_KEY },
      }),
    ).toThrow(/BLOCKED_SEPOLIA_KEY_ENV/);
  });

  it("refuses Sepolia key env on mainnet network", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: MAINNET_NETWORK,
        privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
        expectedBuyerAddress: MAINNET_BUYER_WALLET,
        asset: MAINNET_USDC_ADDRESS,
        env: { SEPOLIA_BUYER_PRIVATE_KEY: SEPOLIA_KEY },
      }),
    ).toThrow(/BLOCKED_MAINNET_KEY_ENV/);
  });

  it("expectedUsdcForNetwork maps chain ids", () => {
    expect(expectedUsdcForNetwork(TESTNET_NETWORK)).toBe(TESTNET_USDC_ADDRESS);
    expect(expectedUsdcForNetwork(MAINNET_NETWORK)).toBe(MAINNET_USDC_ADDRESS);
  });
});
