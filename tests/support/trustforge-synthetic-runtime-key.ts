/**
 * Test-only synthetic runtime key for B.3.3.
 * Hardhat/Anvil account #0 — not an operational TrustForge wallet.
 * Productive code must never import this module.
 */

import { privateKeyToAccount } from "viem/accounts";

import type { HexAddress } from "../../tools/trustforge/buyer-authorization-signer";

/** Recognizable sentinel hex used in leakage adversarial tests. */
export const SYNTHETIC_B33_RUNTIME_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export const SYNTHETIC_B33_RUNTIME_ADDRESS = privateKeyToAccount(
  SYNTHETIC_B33_RUNTIME_KEY,
).address as HexAddress;

/** Wrong-key fixture (Anvil #1) for identity-mismatch cases. */
export const SYNTHETIC_B33_WRONG_RUNTIME_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

export const SYNTHETIC_B33_WRONG_RUNTIME_ADDRESS = privateKeyToAccount(
  SYNTHETIC_B33_WRONG_RUNTIME_KEY,
).address as HexAddress;
