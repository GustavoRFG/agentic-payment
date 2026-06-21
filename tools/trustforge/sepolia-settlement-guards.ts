/**
 * sepolia-settlement-guards — hard-refuse mainnet signals in testnet settlement flow.
 */

import { privateKeyToAccount } from "viem/accounts";
import {
  MAINNET_BUYER_PRIVATE_KEY_ENV,
  MAINNET_BUYER_WALLET,
  SEPOLIA_BUYER_PRIVATE_KEY_ENV,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_TESTNET_BUYER_WALLET,
  assertNotMainnetNetwork,
} from "./network-config";
import { MAINNET_NETWORK, TESTNET_NETWORK } from "../../shared/payment-safety";

export function assertMainnetBuyerKeyAbsent(
  env: Record<string, string | undefined> = process.env,
): void {
  if (env[MAINNET_BUYER_PRIVATE_KEY_ENV]?.trim()) {
    throw new Error(
      `BLOCKED_MAINNET_KEY_PRESENT: ${MAINNET_BUYER_PRIVATE_KEY_ENV} must be absent during Sepolia settlement work`,
    );
  }
}

export function assertSepoliaNetwork(network: string, label = "authorization.network"): void {
  assertNotMainnetNetwork(network, label);
  if (network !== TESTNET_NETWORK) {
    throw new Error(
      `BLOCKED_WRONG_NETWORK: expected ${TESTNET_NETWORK}, got ${network}`,
    );
  }
}

export function assertSepoliaChainId(chainId: number): void {
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `BLOCKED_WRONG_CHAIN: expected chainId ${SEPOLIA_CHAIN_ID}, got ${chainId}`,
    );
  }
  if (chainId === 8453) {
    throw new Error("BLOCKED_MAINNET_CHAIN: chainId 8453 refused in Sepolia flow");
  }
}

export function resolveSepoliaBuyerAddressFromKey(
  privateKey: string,
): `0x${string}` {
  if (!privateKey.startsWith("0x") || privateKey.length !== 66) {
    throw new Error("BLOCKED_INVALID_SEPOLIA_KEY: SEPOLIA_BUYER_PRIVATE_KEY format invalid");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const address = account.address.toLowerCase();
  if (address === MAINNET_BUYER_WALLET.toLowerCase()) {
    throw new Error(
      "BLOCKED_MAINNET_WALLET: resolved address matches mainnet buyer wallet — refused",
    );
  }
  if (address !== SEPOLIA_TESTNET_BUYER_WALLET.toLowerCase()) {
    throw new Error(
      `BLOCKED_WRONG_TESTNET_WALLET: expected ${SEPOLIA_TESTNET_BUYER_WALLET}, got ${account.address}`,
    );
  }
  return account.address;
}

export function preSignSepoliaGuards(input: {
  readonly privateKey: string;
  readonly network: string;
  readonly chainId?: number;
  readonly env?: Record<string, string | undefined>;
}): { readonly buyerAddress: `0x${string}` } {
  assertMainnetBuyerKeyAbsent(input.env);
  assertSepoliaNetwork(input.network);
  if (input.network === MAINNET_NETWORK) {
    throw new Error("BLOCKED_MAINNET_NETWORK: mainnet network refused");
  }
  if (input.chainId !== undefined) {
    assertSepoliaChainId(input.chainId);
  }
  const buyerAddress = resolveSepoliaBuyerAddressFromKey(input.privateKey);
  return { buyerAddress };
}

export function readSepoliaBuyerPrivateKey(
  env: Record<string, string | undefined> = process.env,
): string {
  assertMainnetBuyerKeyAbsent(env);
  const key = env[SEPOLIA_BUYER_PRIVATE_KEY_ENV]?.trim() ?? "";
  if (!key) {
    throw new Error(
      `BLOCKED_WALLET_NOT_CONFIGURED: set ${SEPOLIA_BUYER_PRIVATE_KEY_ENV} (testnet only; never ${MAINNET_BUYER_PRIVATE_KEY_ENV})`,
    );
  }
  return key;
}
