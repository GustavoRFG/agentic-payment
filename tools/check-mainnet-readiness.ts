import dotenv from "dotenv";
import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseUnits,
} from "../seller-api/node_modules/viem/_esm/index.js";
import { privateKeyToAccount } from "../seller-api/node_modules/viem/_esm/accounts/index.js";
import { base } from "../seller-api/node_modules/viem/_esm/chains/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  MAINNET_FACILITATOR_URL,
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  MAX_PAYMENT_ATTEMPTS,
  PAYMENT_AMOUNT_USD,
  PAYMENT_PRICE_LABEL,
  activeFacilitatorUrl,
  activePaymentNetwork,
  activeUsdcAddress,
} from "../seller-api/src/config/safety.ts";
import { projectRootFrom } from "./_lib/child-process.ts";

type Result =
  | "MAINNET_PREFLIGHT_PASSED"
  | "BLOCKED_NEEDS_LOCAL_MAINNET_ENV"
  | "BLOCKED_INSUFFICIENT_MAINNET_USDC";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const REQUIRED_USDC_ATOMIC = parseUnits(PAYMENT_AMOUNT_USD, 6);
const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function loadLocalEnv(root: string): void {
  for (const file of [
    join(root, "seller-api", ".env"),
    join(root, "buyer-client", ".env"),
  ]) {
    if (existsSync(file)) dotenv.config({ path: file, override: false });
  }
}

function truncateAddress(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function privateKeyFromEnv(): `0x${string}` | null {
  const value = process.env.BUYER_PRIVATE_KEY?.trim() ?? "";
  if (!value || value === "0xTESTNET_ONLY_PRIVATE_KEY_DO_NOT_USE_REAL_FUNDS") {
    return null;
  }
  if (!value.startsWith("0x") || value.length !== 66) return null;
  return value as `0x${string}`;
}

function requiredEnvProblems(): string[] {
  const missing: string[] = [];
  if (process.env.X402_USE_MAINNET !== "1") missing.push("X402_USE_MAINNET");
  if (!process.env.SELLER_RECEIVER_ADDRESS?.trim()) {
    missing.push("SELLER_RECEIVER_ADDRESS");
  }
  if (!process.env.CDP_API_KEY_ID?.trim()) missing.push("CDP_API_KEY_ID");
  if (!process.env.CDP_API_KEY_SECRET?.trim()) missing.push("CDP_API_KEY_SECRET");
  if (!privateKeyFromEnv()) missing.push("BUYER_PRIVATE_KEY");
  return missing;
}

async function readBalances(address: `0x${string}`): Promise<{
  ethBalance: bigint;
  usdcBalance: bigint;
}> {
  const rpcUrl = process.env.BASE_MAINNET_RPC_URL?.trim();
  const client = createPublicClient({
    chain: base,
    transport: rpcUrl ? http(rpcUrl) : http(),
  });
  const chainId = await client.getChainId();
  if (chainId !== base.id) {
    throw new Error(`BASE_MAINNET_RPC_URL returned chainId=${chainId}, expected ${base.id}`);
  }
  const [ethBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({
      address: MAINNET_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    }),
  ]);
  return { ethBalance, usdcBalance };
}

function printStaticChecks(): void {
  console.log("Mainnet preflight");
  console.log("-----------------");
  console.log(`active network: ${activePaymentNetwork()}`);
  console.log(`active facilitator: ${activeFacilitatorUrl()}`);
  console.log(`active USDC address: ${activeUsdcAddress()}`);
  console.log(`price /paid/analyze-text: ${PAYMENT_PRICE_LABEL}`);
  console.log(`MAX_PAYMENT_ATTEMPTS: ${MAX_PAYMENT_ATTEMPTS}`);
  console.log("MAINNET_PAYMENT_CONFIRMATION required for preflight: No");
}

async function main(): Promise<void> {
  const root = projectRootFrom(import.meta.url);
  loadLocalEnv(root);
  printStaticChecks();

  const missing = requiredEnvProblems();
  const receiver = process.env.SELLER_RECEIVER_ADDRESS?.trim() ?? "";
  if (receiver && (!isAddress(receiver) || receiver.toLowerCase() === ZERO_ADDRESS.toLowerCase())) {
    missing.push("SELLER_RECEIVER_ADDRESS_VALID_NONZERO");
  }

  if (
    activePaymentNetwork() !== MAINNET_NETWORK ||
    activeFacilitatorUrl() !== MAINNET_FACILITATOR_URL ||
    activeUsdcAddress() !== MAINNET_USDC_ADDRESS
  ) {
    missing.push("ACTIVE_MAINNET_CONFIGURATION");
  }

  const privateKey = privateKeyFromEnv();
  const buyerAddress = privateKey ? privateKeyToAccount(privateKey).address : "";

  console.log(
    `seller receiver: ${
      isAddress(receiver) ? truncateAddress(receiver) : "(missing-or-invalid)"
    }`,
  );
  console.log(
    `buyer address: ${
      buyerAddress && isAddress(buyerAddress)
        ? truncateAddress(buyerAddress)
        : "(missing-or-invalid)"
    }`,
  );
  console.log(`CDP credentials present: ${missing.some((v) => v.startsWith("CDP_")) ? "No" : "Yes"}`);
  console.log(`buyer private key present: ${privateKey ? "Yes" : "No"}`);

  if (missing.length > 0 || !privateKey || !isAddress(buyerAddress)) {
    console.log(`Missing or invalid: ${[...new Set(missing)].join(", ")}`);
    console.log("RESULT: BLOCKED_NEEDS_LOCAL_MAINNET_ENV");
    process.exitCode = 1;
    return;
  }

  let balances: Awaited<ReturnType<typeof readBalances>>;
  try {
    balances = await readBalances(buyerAddress);
  } catch (error) {
    console.log(
      `Balance check failed: ${(error as Error).message}. ` +
        "Set BASE_MAINNET_RPC_URL if the default RPC is unavailable.",
    );
    console.log("Missing or invalid: BASE_MAINNET_RPC_URL");
    console.log("RESULT: BLOCKED_NEEDS_LOCAL_MAINNET_ENV");
    process.exitCode = 1;
    return;
  }

  const usdcOk = balances.usdcBalance >= REQUIRED_USDC_ATOMIC;
  console.log(`buyer Base mainnet USDC balance: ${formatUnits(balances.usdcBalance, 6)} USDC`);
  console.log(`buyer Base mainnet ETH balance: ${formatEther(balances.ethBalance)} ETH`);
  console.log("ETH balance requirement: informational only for EIP-3009");

  if (!usdcOk) {
    console.log("RESULT: BLOCKED_INSUFFICIENT_MAINNET_USDC");
    process.exitCode = 1;
    return;
  }

  console.log("RESULT: MAINNET_PREFLIGHT_PASSED");
}

main().catch((error) => {
  console.error("[mainnet:check] error:", (error as Error).message);
  console.log("RESULT: BLOCKED_NEEDS_LOCAL_MAINNET_ENV");
  process.exitCode = 1;
});
