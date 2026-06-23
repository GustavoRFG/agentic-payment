/**
 * x402-settlement-profile — network profile for thin settlement + classify (Sepolia + mainnet).
 */

import {
  MAINNET_BUYER_PRIVATE_KEY_ENV,
  MAINNET_BUYER_WALLET,
  MAINNET_CHAIN_ID,
  MAINNET_PROFILE,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_TESTNET_BUYER_WALLET,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_PROFILE,
  type TrustForgeNetwork,
  type TrustForgeNetworkProfile,
  isMainnetCaip2,
} from "./network-config";
import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import { assertOppositeNetworkKeyAbsent } from "./settlement-network-guards";

export interface X402SettlementProfile {
  readonly id: TrustForgeNetwork;
  readonly caip2: string;
  readonly chainId: number;
  readonly usdcContract: string;
  readonly buyerWallet: string;
  readonly privateKeyEnvName: string;
  readonly reconcileCliNetwork: "mainnet" | "sepolia";
  readonly reconciliationDirName: string;
  readonly matchedRunLabel: string;
  readonly require402BeforePayment: boolean;
}

function fromTrustForgeProfile(
  base: TrustForgeNetworkProfile,
  privateKeyEnvName: string,
): X402SettlementProfile {
  return {
    id: base.id,
    caip2: base.caip2,
    chainId: base.chainId,
    usdcContract: base.usdcContract,
    buyerWallet: base.buyerWallet,
    privateKeyEnvName,
    reconcileCliNetwork: base.id,
    reconciliationDirName: base.id === "sepolia" ? "sepolia_reconciliation" : "mainnet_reconciliation",
    matchedRunLabel: "thin_settlement_proof",
    require402BeforePayment: true,
  };
}

export const MAINNET_X402_SETTLEMENT_PROFILE: X402SettlementProfile = fromTrustForgeProfile(
  MAINNET_PROFILE,
  MAINNET_BUYER_PRIVATE_KEY_ENV,
);

export const SEPOLIA_X402_SETTLEMENT_PROFILE: X402SettlementProfile = fromTrustForgeProfile(
  SEPOLIA_PROFILE,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
);

export function resolveX402SettlementProfileFromNetwork(network: string): X402SettlementProfile {
  if (network === TESTNET_NETWORK || network === "84532" || network === "sepolia") {
    return SEPOLIA_X402_SETTLEMENT_PROFILE;
  }
  if (network === MAINNET_NETWORK || network === "8453" || network === "mainnet") {
    return MAINNET_X402_SETTLEMENT_PROFILE;
  }
  if (isMainnetCaip2(network)) {
    return MAINNET_X402_SETTLEMENT_PROFILE;
  }
  if (network.startsWith("eip155:")) {
    const chainId = Number.parseInt(network.slice("eip155:".length), 10);
    if (chainId === SEPOLIA_CHAIN_ID) return SEPOLIA_X402_SETTLEMENT_PROFILE;
    if (chainId === MAINNET_CHAIN_ID) return MAINNET_X402_SETTLEMENT_PROFILE;
  }
  throw new Error(`BLOCKED_UNSUPPORTED_SETTLEMENT_NETWORK: ${network}`);
}

export function resolveX402SettlementProfileFromCli(
  networkArg: string | undefined,
  selectedNetwork: string | undefined,
): X402SettlementProfile {
  if (networkArg) {
    return resolveX402SettlementProfileFromNetwork(
      networkArg === "mainnet" ? MAINNET_NETWORK : networkArg === "sepolia" ? TESTNET_NETWORK : networkArg,
    );
  }
  if (!selectedNetwork) {
    throw new Error("BLOCKED_MISSING_NETWORK: pass --network or selected_candidate.network");
  }
  return resolveX402SettlementProfileFromNetwork(selectedNetwork);
}

export function assertProfileEnvBeforeSettlement(
  profile: X402SettlementProfile,
  env: Record<string, string | undefined> = process.env,
): void {
  assertOppositeNetworkKeyAbsent(profile.privateKeyEnvName, env);
  if (profile.id === "sepolia") {
    if (env[MAINNET_BUYER_PRIVATE_KEY_ENV]?.trim()) {
      throw new Error("BLOCKED_CROSS_NETWORK_KEY: BUYER_PRIVATE_KEY must be absent on Sepolia");
    }
    if (env.X402_USE_MAINNET === "1") {
      throw new Error("BLOCKED_MAINNET_SIGNAL: X402_USE_MAINNET must not be set on Sepolia");
    }
  }
  if (profile.id === "mainnet") {
    if (env[SEPOLIA_BUYER_PRIVATE_KEY_ENV]?.trim()) {
      throw new Error("BLOCKED_CROSS_NETWORK_KEY: SEPOLIA_BUYER_PRIVATE_KEY must be absent on mainnet");
    }
  }
}

export function expectedAssetForProfile(profile: X402SettlementProfile): string {
  return profile.id === "sepolia" ? TESTNET_USDC_ADDRESS : MAINNET_USDC_ADDRESS;
}
