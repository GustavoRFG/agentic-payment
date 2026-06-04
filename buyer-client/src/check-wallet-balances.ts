/**
 * MVP 001B.1 wallet balance preflight.
 *
 * Read-only Base wallet balance check. This script derives the buyer address
 * from BUYER_PRIVATE_KEY, never prints the key, and never signs or pays.
 */

import {
  createPublicClient,
  formatEther,
  formatUnits,
  http,
  isAddress,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import {
  MAINNET_NETWORK,
  PAYMENT_AMOUNT_USD,
  activePaymentNetwork,
  activeUsdcAddress,
} from "../../shared/payment-safety";
import { loadEnvUnlessDisabled } from "./config/loadEnv";

loadEnvUnlessDisabled();

const EXPECTED_NETWORK = activePaymentNetwork();
const EXPECTED_CHAIN = EXPECTED_NETWORK === MAINNET_NETWORK ? base : baseSepolia;
const EXPECTED_USDC = activeUsdcAddress();
const REQUIRED_USDC_ATOMIC = parseUnits(PAYMENT_AMOUNT_USD, 6);
const REQUIRED_ETH_WEI = 1n;
const PLACEHOLDER_PRIVATE_KEY =
  "0xTESTNET_ONLY_PRIVATE_KEY_DO_NOT_USE_REAL_FUNDS";

const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function privateKeyFromEnv(): `0x${string}` | null {
  const value = process.env.BUYER_PRIVATE_KEY?.trim() ?? "";
  if (!value) return null;
  if (value === PLACEHOLDER_PRIVATE_KEY) return null;
  if (!value.startsWith("0x") || value.length !== 66) return null;
  return value as `0x${string}`;
}

async function main(): Promise<void> {
  const isMainnet = EXPECTED_NETWORK === MAINNET_NETWORK;
  console.log("Base wallet balance check");
  console.log("-------------------------");
  console.log(`Network: ${EXPECTED_NETWORK}`);
  console.log(`Asset target: USDC ${isMainnet ? "Base mainnet" : "Base Sepolia"}`);
  console.log("Required USDC: 0.001 / 1000 atomic units");

  const privateKey = privateKeyFromEnv();
  if (privateKey === null) {
    console.error(
      "BUYER_PRIVATE_KEY is missing, placeholder, or invalid. Configure a " +
        "fresh dedicated wallet before checking balances.",
    );
    process.exitCode = 1;
    return;
  }

  const account = privateKeyToAccount(privateKey);
  if (!isAddress(account.address)) {
    console.error("Derived buyer address is invalid.");
    process.exitCode = 1;
    return;
  }

  const rpcUrl = (
    isMainnet
      ? process.env.BASE_MAINNET_RPC_URL
      : process.env.BASE_SEPOLIA_RPC_URL
  )?.trim();
  const client = createPublicClient({
    chain: EXPECTED_CHAIN,
    transport: rpcUrl ? http(rpcUrl) : http(),
  });

  const chainId = await client.getChainId();
  if (chainId !== EXPECTED_CHAIN.id) {
    console.error(`RPC returned chainId=${chainId}; expected ${EXPECTED_CHAIN.id}.`);
    process.exitCode = 1;
    return;
  }

  const [ethBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({
      address: EXPECTED_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    }),
  ]);

  const ethOk = ethBalance >= REQUIRED_ETH_WEI;
  const usdcOk = usdcBalance >= REQUIRED_USDC_ATOMIC;

  console.log(`Buyer address: ${account.address}`);
  console.log(`ETH balance: ${formatEther(ethBalance)} ETH`);
  console.log(`USDC balance: ${formatUnits(usdcBalance, 6)} USDC`);
  console.log(
    `ETH status: ${
      isMainnet
        ? "informational only for EIP-3009"
        : ethOk
          ? "pass"
          : "missing Base Sepolia ETH for gas"
    }`,
  );
  console.log(
    `USDC status: ${
      usdcOk
        ? "pass"
        : `missing at least ${PAYMENT_AMOUNT_USD} ${
            isMainnet ? "Base mainnet" : "Base Sepolia"
          } USDC`
    }`,
  );
  console.log("Payment execution: not performed by this script");

  process.exitCode = (isMainnet ? usdcOk : ethOk && usdcOk) ? 0 : 1;
}

main().catch((error) => {
  console.error("[wallet:check] error:", (error as Error).message);
  process.exitCode = 1;
});
