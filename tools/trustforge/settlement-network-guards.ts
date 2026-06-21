/**
 * settlement-network-guards — parameterized pre-sign guards for x402 settlement.
 */

import { privateKeyToAccount } from "viem/accounts";
import {
  MAINNET_BUYER_PRIVATE_KEY_ENV,
  MAINNET_BUYER_WALLET,
  MAINNET_CHAIN_ID,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_TESTNET_BUYER_WALLET,
  assertNotMainnetNetwork,
} from "./network-config";
import {
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";

export function parseCaip2ChainId(network: string): number {
  if (network === MAINNET_NETWORK || network === "8453") return MAINNET_CHAIN_ID;
  if (network === TESTNET_NETWORK || network === "84532") return SEPOLIA_CHAIN_ID;
  const match = /^eip155:(\d+)$/.exec(network.trim());
  if (!match) {
    throw new Error(`BLOCKED_INVALID_NETWORK: ${network}`);
  }
  return Number.parseInt(match[1], 10);
}

export function expectedUsdcForNetwork(network: string): string {
  const chainId = parseCaip2ChainId(network);
  if (chainId === SEPOLIA_CHAIN_ID) return TESTNET_USDC_ADDRESS;
  if (chainId === MAINNET_CHAIN_ID) return MAINNET_USDC_ADDRESS;
  throw new Error(`BLOCKED_UNSUPPORTED_CHAIN: ${chainId}`);
}

export function expectedBuyerWalletForNetwork(network: string): string {
  const chainId = parseCaip2ChainId(network);
  if (chainId === SEPOLIA_CHAIN_ID) return SEPOLIA_TESTNET_BUYER_WALLET;
  if (chainId === MAINNET_CHAIN_ID) return MAINNET_BUYER_WALLET;
  throw new Error(`BLOCKED_UNSUPPORTED_CHAIN: ${chainId}`);
}

export function oppositePrivateKeyEnv(privateKeyEnvName: string): string {
  if (privateKeyEnvName === SEPOLIA_BUYER_PRIVATE_KEY_ENV) {
    return MAINNET_BUYER_PRIVATE_KEY_ENV;
  }
  if (privateKeyEnvName === MAINNET_BUYER_PRIVATE_KEY_ENV) {
    return SEPOLIA_BUYER_PRIVATE_KEY_ENV;
  }
  throw new Error(`BLOCKED_UNKNOWN_KEY_ENV: ${privateKeyEnvName}`);
}

export function assertOppositeNetworkKeyAbsent(
  privateKeyEnvName: string,
  env: Record<string, string | undefined> = process.env,
): void {
  const opposite = oppositePrivateKeyEnv(privateKeyEnvName);
  if (env[opposite]?.trim()) {
    throw new Error(
      `BLOCKED_CROSS_NETWORK_KEY: ${opposite} must be absent when using ${privateKeyEnvName}`,
    );
  }
}

export function readSettlementPrivateKey(
  privateKeyEnvName: string,
  env: Record<string, string | undefined> = process.env,
): string {
  assertOppositeNetworkKeyAbsent(privateKeyEnvName, env);
  const key = env[privateKeyEnvName]?.trim() ?? "";
  if (!key) {
    throw new Error(`BLOCKED_WALLET_NOT_CONFIGURED: set ${privateKeyEnvName}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(`BLOCKED_INVALID_KEY: ${privateKeyEnvName} format invalid`);
  }
  return key;
}

export function assertSettlementNetworkGuards(input: {
  readonly network: string;
  readonly privateKeyEnvName: string;
  readonly expectedBuyerAddress: string;
  readonly asset: string;
  readonly env?: Record<string, string | undefined>;
}): { readonly privateKey: string; readonly buyerAddress: `0x${string}`; readonly chainId: number } {
  const env = input.env ?? process.env;
  assertOppositeNetworkKeyAbsent(input.privateKeyEnvName, env);

  const chainId = parseCaip2ChainId(input.network);
  if (chainId === MAINNET_CHAIN_ID && input.privateKeyEnvName !== MAINNET_BUYER_PRIVATE_KEY_ENV) {
    throw new Error("BLOCKED_MAINNET_KEY_ENV: mainnet requires BUYER_PRIVATE_KEY");
  }
  if (chainId === SEPOLIA_CHAIN_ID && input.privateKeyEnvName !== SEPOLIA_BUYER_PRIVATE_KEY_ENV) {
    throw new Error("BLOCKED_SEPOLIA_KEY_ENV: Sepolia requires SEPOLIA_BUYER_PRIVATE_KEY");
  }
  if (chainId === SEPOLIA_CHAIN_ID) {
    assertNotMainnetNetwork(input.network);
    if (env.X402_USE_MAINNET === "1") {
      throw new Error("BLOCKED_MAINNET_SIGNAL: X402_USE_MAINNET must not be set on Sepolia");
    }
  }

  const expectedAsset = expectedUsdcForNetwork(input.network);
  if (input.asset.toLowerCase() !== expectedAsset.toLowerCase()) {
    throw new Error(
      `BLOCKED_WRONG_ASSET: expected ${expectedAsset} for ${input.network}, got ${input.asset}`,
    );
  }

  const privateKey = readSettlementPrivateKey(input.privateKeyEnvName, env);
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const resolved = account.address.toLowerCase();
  const expected = input.expectedBuyerAddress.toLowerCase();

  if (chainId === SEPOLIA_CHAIN_ID && resolved === MAINNET_BUYER_WALLET.toLowerCase()) {
    throw new Error("BLOCKED_MAINNET_WALLET: resolved address is mainnet buyer wallet");
  }
  if (chainId === MAINNET_CHAIN_ID && resolved === SEPOLIA_TESTNET_BUYER_WALLET.toLowerCase()) {
    throw new Error("BLOCKED_TESTNET_WALLET: resolved address is Sepolia test wallet");
  }
  if (resolved !== expected) {
    throw new Error(
      `BLOCKED_WRONG_WALLET: expected ${input.expectedBuyerAddress}, got ${account.address}`,
    );
  }

  return { privateKey, buyerAddress: account.address, chainId };
}

// Backward-compatible Sepolia-only exports
export function assertMainnetBuyerKeyAbsent(
  env: Record<string, string | undefined> = process.env,
): void {
  assertOppositeNetworkKeyAbsent(SEPOLIA_BUYER_PRIVATE_KEY_ENV, env);
}

export function assertSepoliaNetwork(network: string, label = "authorization.network"): void {
  assertNotMainnetNetwork(network, label);
  if (network !== TESTNET_NETWORK) {
    throw new Error(`BLOCKED_WRONG_NETWORK: expected ${TESTNET_NETWORK}, got ${network}`);
  }
}

export function assertSepoliaChainId(chainId: number): void {
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(`BLOCKED_WRONG_CHAIN: expected chainId ${SEPOLIA_CHAIN_ID}, got ${chainId}`);
  }
}

export function preSignSepoliaGuards(input: {
  readonly privateKey: string;
  readonly network: string;
  readonly chainId?: number;
  readonly env?: Record<string, string | undefined>;
}): { readonly buyerAddress: `0x${string}` } {
  const result = assertSettlementNetworkGuards({
    network: input.network,
    privateKeyEnvName: SEPOLIA_BUYER_PRIVATE_KEY_ENV,
    expectedBuyerAddress: SEPOLIA_TESTNET_BUYER_WALLET,
    asset: TESTNET_USDC_ADDRESS,
    env: { ...input.env, [SEPOLIA_BUYER_PRIVATE_KEY_ENV]: input.privateKey },
  });
  if (input.chainId !== undefined && input.chainId !== result.chainId) {
    throw new Error(`BLOCKED_WRONG_CHAIN: expected ${input.chainId}, got ${result.chainId}`);
  }
  return { buyerAddress: result.buyerAddress };
}

export function readSepoliaBuyerPrivateKey(
  env: Record<string, string | undefined> = process.env,
): string {
  assertMainnetBuyerKeyAbsent(env);
  return readSettlementPrivateKey(SEPOLIA_BUYER_PRIVATE_KEY_ENV, env);
}

export function resolveSepoliaBuyerAddressFromKey(privateKey: string): `0x${string}` {
  return preSignSepoliaGuards({
    privateKey,
    network: TESTNET_NETWORK,
    chainId: SEPOLIA_CHAIN_ID,
  }).buyerAddress;
}
