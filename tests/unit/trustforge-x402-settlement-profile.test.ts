import { describe, expect, it } from "vitest";

import {
  MAINNET_BUYER_PRIVATE_KEY_ENV,
  MAINNET_BUYER_WALLET,
  MAINNET_CHAIN_ID,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_TESTNET_BUYER_WALLET,
  SEPOLIA_CHAIN_ID,
} from "../../tools/trustforge/network-config";
import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import {
  assertProfileEnvBeforeSettlement,
  MAINNET_X402_SETTLEMENT_PROFILE,
  resolveX402SettlementProfileFromNetwork,
  SEPOLIA_X402_SETTLEMENT_PROFILE,
} from "../../tools/trustforge/x402-settlement-profile";
import { assertSettlementNetworkGuards } from "../../tools/trustforge/settlement-network-guards";

describe("x402 settlement profiles", () => {
  it("Sepolia profile uses testnet network and Sepolia key env", () => {
    expect(SEPOLIA_X402_SETTLEMENT_PROFILE.caip2).toBe(TESTNET_NETWORK);
    expect(SEPOLIA_X402_SETTLEMENT_PROFILE.privateKeyEnvName).toBe(SEPOLIA_BUYER_PRIVATE_KEY_ENV);
    expect(SEPOLIA_X402_SETTLEMENT_PROFILE.chainId).toBe(SEPOLIA_CHAIN_ID);
    expect(SEPOLIA_X402_SETTLEMENT_PROFILE.usdcContract).toBe(TESTNET_USDC_ADDRESS);
    expect(SEPOLIA_X402_SETTLEMENT_PROFILE.buyerWallet).toBe(SEPOLIA_TESTNET_BUYER_WALLET);
  });

  it("Mainnet profile uses Base mainnet and BUYER key env", () => {
    expect(MAINNET_X402_SETTLEMENT_PROFILE.caip2).toBe(MAINNET_NETWORK);
    expect(MAINNET_X402_SETTLEMENT_PROFILE.privateKeyEnvName).toBe(MAINNET_BUYER_PRIVATE_KEY_ENV);
    expect(MAINNET_X402_SETTLEMENT_PROFILE.chainId).toBe(MAINNET_CHAIN_ID);
    expect(MAINNET_X402_SETTLEMENT_PROFILE.usdcContract).toBe(MAINNET_USDC_ADDRESS);
    expect(MAINNET_X402_SETTLEMENT_PROFILE.buyerWallet).toBe(MAINNET_BUYER_WALLET);
  });

  it("resolves profile from selected_candidate network", () => {
    expect(resolveX402SettlementProfileFromNetwork(TESTNET_NETWORK).id).toBe("sepolia");
    expect(resolveX402SettlementProfileFromNetwork(MAINNET_NETWORK).id).toBe("mainnet");
  });

  it("mainnet env guard refuses Sepolia key when present", () => {
    expect(() =>
      assertProfileEnvBeforeSettlement(MAINNET_X402_SETTLEMENT_PROFILE, {
        [MAINNET_BUYER_PRIVATE_KEY_ENV]: "0x" + "11".repeat(32),
        [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: "0x" + "22".repeat(32),
      }),
    ).toThrow(/BLOCKED_CROSS_NETWORK_KEY/);
  });

  it("mainnet guard refuses wrong wallet before signing", () => {
    expect(() =>
      assertSettlementNetworkGuards({
        network: MAINNET_NETWORK,
        privateKeyEnvName: MAINNET_BUYER_PRIVATE_KEY_ENV,
        expectedBuyerAddress: MAINNET_BUYER_WALLET,
        asset: MAINNET_USDC_ADDRESS,
        env: { [MAINNET_BUYER_PRIVATE_KEY_ENV]: "0x" + "22".repeat(32) },
      }),
    ).toThrow(/BLOCKED_WRONG_WALLET/);
  });
});
