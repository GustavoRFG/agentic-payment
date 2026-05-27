/**
 * Requests Base Sepolia ETH from the CDP Faucet for the lab buyer address.
 *
 * This script reads only ../secrets/cdp.env, never prints credential values,
 * and does not sign or execute any x402 payment.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient } from "@coinbase/cdp-sdk";
import dotenv from "dotenv";
import { isAddress } from "viem";

const TARGET_ADDRESS = "0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392";
const NETWORK = "base-sepolia";
const TOKEN = "eth";

type EnvMap = Record<string, string | undefined>;

const credentialKeys = {
  apiKeyId: ["CDP_API_KEY_ID", "API_key_ID"],
  apiKeySecret: ["CDP_API_KEY_SECRET", "API_SECRET"],
  walletSecret: ["CDP_WALLET_SECRET", "wallet_secret"],
} as const;

let redactionSecrets: string[] = [];

function loadLocalCdpEnv(): EnvMap {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const envPath = resolve(scriptDir, "../../secrets/cdp.env");

  if (!existsSync(envPath)) {
    throw new Error("secrets/cdp.env was not found.");
  }

  return dotenv.parse(readFileSync(envPath));
}

function firstPresent(env: EnvMap, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }

  return undefined;
}

function redact(message: string, secrets: readonly string[]): string {
  return secrets.reduce((current, secret) => {
    if (!secret) return current;
    return current.split(secret).join("[redacted]");
  }, message);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function main(): Promise<void> {
  if (!isAddress(TARGET_ADDRESS)) {
    throw new Error("Configured faucet address is invalid.");
  }

  if (NETWORK !== "base-sepolia" || TOKEN !== "eth") {
    throw new Error("Unsafe faucet configuration; expected base-sepolia ETH.");
  }

  const env = loadLocalCdpEnv();
  const apiKeyId = firstPresent(env, credentialKeys.apiKeyId);
  const apiKeySecret = firstPresent(env, credentialKeys.apiKeySecret);
  const walletSecret = firstPresent(env, credentialKeys.walletSecret);
  redactionSecrets = [apiKeyId, apiKeySecret, walletSecret].filter(
    (value): value is string => Boolean(value),
  );

  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      "CDP credentials are incomplete in secrets/cdp.env. Required: CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET.",
    );
  }

  console.log("CDP credential check: present");
  console.log(`Faucet request: network=${NETWORK} token=${TOKEN} address=${TARGET_ADDRESS}`);

  const cdp = new CdpClient({
    apiKeyId,
    apiKeySecret,
    walletSecret,
  });

  const { transactionHash } = await cdp.evm.requestFaucet({
    address: TARGET_ADDRESS,
    network: NETWORK,
    token: TOKEN,
  });

  console.log(`CDP Faucet transaction hash: ${transactionHash}`);
}

main().catch((error) => {
  console.error(`CDP Faucet error: ${redact(errorMessage(error), redactionSecrets)}`);
  process.exitCode = 1;
});
