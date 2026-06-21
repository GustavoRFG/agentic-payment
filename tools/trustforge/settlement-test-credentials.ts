/**
 * settlement-test-credentials — deterministic keys for unit tests only.
 *
 * Derived via viem at module load; never import from live settlement runners.
 */

import { privateKeyToAccount } from "viem/accounts";

export const TEST_SIGNING_KEY_A =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

export const TEST_SIGNING_KEY_B =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff81" as const;

export const TEST_SIGNING_ADDRESS_A = privateKeyToAccount(TEST_SIGNING_KEY_A).address;

export const TEST_SIGNING_ADDRESS_B = privateKeyToAccount(TEST_SIGNING_KEY_B).address;
