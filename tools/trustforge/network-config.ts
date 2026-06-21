/**
 * TrustForge network profiles — mainnet vs Base Sepolia testnet.
 */

import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";

export const SEPOLIA_CHAIN_ID = 84532 as const;
export const MAINNET_CHAIN_ID = 8453 as const;

export const SEPOLIA_TESTNET_BUYER_WALLET =
  "0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392" as const;

export const MAINNET_BUYER_WALLET =
  "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1" as const;

export const SEPOLIA_BUYER_PRIVATE_KEY_ENV = "SEPOLIA_BUYER_PRIVATE_KEY" as const;
export const MAINNET_BUYER_PRIVATE_KEY_ENV = "BUYER_PRIVATE_KEY" as const;

export const TRUSTFORGE_SEPOLIA_RPC_URL_ENV = "TRUSTFORGE_SEPOLIA_RPC_URL" as const;
export const TRUSTFORGE_SEPOLIA_RPC_FALLBACK_URLS_ENV =
  "TRUSTFORGE_SEPOLIA_RPC_FALLBACK_URLS" as const;

export type TrustForgeNetwork = "mainnet" | "sepolia";

export interface TrustForgeNetworkProfile {
  readonly id: TrustForgeNetwork;
  readonly caip2: typeof MAINNET_NETWORK | typeof TESTNET_NETWORK;
  readonly chainId: typeof MAINNET_CHAIN_ID | typeof SEPOLIA_CHAIN_ID;
  readonly usdcContract: string;
  readonly buyerWallet: string;
  readonly rpcPrimaryEnv: string;
  readonly rpcFallbackEnv: string;
  readonly defaultRpcs: readonly string[];
}

export const MAINNET_PROFILE: TrustForgeNetworkProfile = {
  id: "mainnet",
  caip2: MAINNET_NETWORK,
  chainId: MAINNET_CHAIN_ID,
  usdcContract: MAINNET_USDC_ADDRESS,
  buyerWallet: MAINNET_BUYER_WALLET,
  rpcPrimaryEnv: "TRUSTFORGE_BASE_RPC_URL",
  rpcFallbackEnv: "TRUSTFORGE_BASE_RPC_FALLBACK_URLS",
  defaultRpcs: [
    "https://mainnet.base.org",
    "https://base-rpc.publicnode.com",
    "https://base.drpc.org",
  ],
};

export const SEPOLIA_PROFILE: TrustForgeNetworkProfile = {
  id: "sepolia",
  caip2: TESTNET_NETWORK,
  chainId: SEPOLIA_CHAIN_ID,
  usdcContract: TESTNET_USDC_ADDRESS,
  buyerWallet: SEPOLIA_TESTNET_BUYER_WALLET,
  rpcPrimaryEnv: TRUSTFORGE_SEPOLIA_RPC_URL_ENV,
  rpcFallbackEnv: TRUSTFORGE_SEPOLIA_RPC_FALLBACK_URLS_ENV,
  defaultRpcs: [
    "https://sepolia.base.org",
    "https://base-sepolia-rpc.publicnode.com",
    "https://base-sepolia.drpc.org",
  ],
};

export function resolveNetworkProfile(network: TrustForgeNetwork): TrustForgeNetworkProfile {
  return network === "sepolia" ? SEPOLIA_PROFILE : MAINNET_PROFILE;
}

export function isMainnetCaip2(network: string): boolean {
  return network === MAINNET_NETWORK || network === "8453" || network === "eip155:8453";
}

export function assertNotMainnetNetwork(network: string, label = "network"): void {
  if (isMainnetCaip2(network)) {
    throw new Error(`BLOCKED_MAINNET_SIGNAL: ${label} must not be mainnet (${network})`);
  }
}
