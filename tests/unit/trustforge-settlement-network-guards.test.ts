import { describe, expect, it } from "vitest";
import {
  assertSettlementNetworkGuards,
  assertOppositeNetworkKeyAbsent,
  expectedUsdcForNetwork,
} from "../../tools/trustforge/settlement-network-guards";
import {
  MAINNET_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_TESTNET_BUYER_WALLET,
} from "../../tools/trustforge/network-config";
import {
  TEST_SIGNING_ADDRESS_A,
  TEST_SIGNING_ADDRESS_B,
  TEST_SIGNING_KEY_A,
  TEST_SIGNING_KEY_B,
} from "../../tools/trustforge/settlement-test-credentials";
import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";

const MAINNET_KEY = "0x" + "bb".repeat(32);
const SEPOLIA_KEY = "0x" + "aa".repeat(32);

describe("settlement-network-guards", () => {
  it("Sepolia path passes when key resolves to expected buyer address", () => {
    const result = assertSettlementNetworkGuards({
      network: TESTNET_NETWORK,
      privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
      expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
      asset: TESTNET_USDC_ADDRESS,
      env: {
        [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A,
        BUYER_PRIVATE_KEY: "",
      },
    });
    expect(result.chainId).toBe(84532);
    expect(result.buyerAddress.toLowerCase()).toBe(TEST_SIGNING_ADDRESS_A.toLowerCase());
  });

  it("mainnet path passes with deterministic test credentials", () => {
    const result = assertSettlementNetworkGuards({
      network: MAINNET_NETWORK,
      privateKeyEnvName: MAINNET_BUYER_PRIVATE_KEY_ENV,
      expectedBuyerAddress: TEST_SIGNING_ADDRESS_B,
      asset: MAINNET_USDC_ADDRESS,
      env: {
        BUYER_PRIVATE_KEY: TEST_SIGNING_KEY_B,
        SEPOLIA_BUYER_PRIVATE_KEY: "",
      },
    });
    expect(result.chainId).toBe(8453);
    expect(result.buyerAddress.toLowerCase()).toBe(TEST_SIGNING_ADDRESS_B.toLowerCase());
  });

  it("hard-fails BLOCKED_WRONG_WALLET when key valid but expectedBuyerAddress mismatches", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: TESTNET_NETWORK,
        privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
        expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
        asset: TESTNET_USDC_ADDRESS,
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A },
      }),
    ).toThrow(/BLOCKED_WRONG_WALLET/);
  });

  it("hard-fails before signing when a different valid key is supplied", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: TESTNET_NETWORK,
        privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
        expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
        asset: TESTNET_USDC_ADDRESS,
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_B },
      }),
    ).toThrow(/BLOCKED_WRONG_WALLET/);
  });

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
        expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
        asset: MAINNET_USDC_ADDRESS,
        env: { [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: TEST_SIGNING_KEY_A },
      }),
    ).toThrow(/BLOCKED_WRONG_ASSET/);
  });

  it("refuses mainnet key env on Sepolia network", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: TESTNET_NETWORK,
        privateKeyEnvName: MAINNET_BUYER_PRIVATE_KEY_ENV,
        expectedBuyerAddress: TEST_SIGNING_ADDRESS_A,
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
        expectedBuyerAddress: TEST_SIGNING_ADDRESS_B,
        asset: MAINNET_USDC_ADDRESS,
        env: { SEPOLIA_BUYER_PRIVATE_KEY: SEPOLIA_KEY },
      }),
    ).toThrow(/BLOCKED_MAINNET_KEY_ENV/);
  });

  it("refuses wrong network caip2 on mainnet guard path", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: TESTNET_NETWORK,
        privateKeyEnvName: MAINNET_BUYER_PRIVATE_KEY_ENV,
        expectedBuyerAddress: TEST_SIGNING_ADDRESS_B,
        asset: MAINNET_USDC_ADDRESS,
        env: { BUYER_PRIVATE_KEY: TEST_SIGNING_KEY_B },
      }),
    ).toThrow(/BLOCKED_SEPOLIA_KEY_ENV/);
  });

  it("expectedUsdcForNetwork maps chain ids", () => {
    expect(expectedUsdcForNetwork(TESTNET_NETWORK)).toBe(TESTNET_USDC_ADDRESS);
    expect(expectedUsdcForNetwork(MAINNET_NETWORK)).toBe(MAINNET_USDC_ADDRESS);
  });
});
