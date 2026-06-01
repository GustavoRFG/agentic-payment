/**
 * MVP 001B.1 wallet balance preflight.
 *
 * Read-only Base Sepolia balance check. This script derives the buyer address
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
import { baseSepolia } from "viem/chains";
import { loadEnvUnlessDisabled } from "./config/loadEnv";

loadEnvUnlessDisabled();

const EXPECTED_CHAIN_ID = 84532;
const EXPECTED_NETWORK = "eip155:84532";
const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const REQUIRED_USDC_ATOMIC = parseUnits("0.001", 6);
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
  const configuredNetwork = process.env.X402_NETWORK ?? EXPECTED_NETWORK;
  console.log("Base Sepolia wallet balance check");
  console.log("---------------------------------");
  console.log(`Network: ${configuredNetwork}`);
  console.log("Asset target: USDC Base Sepolia");
  console.log("Required USDC: 0.001 / 1000 atomic units");

  if (configuredNetwork !== EXPECTED_NETWORK) {
    console.error(
      `Unsafe X402_NETWORK=${configuredNetwork}; expected ${EXPECTED_NETWORK}.`,
    );
    process.exitCode = 1;
    return;
  }

  const privateKey = privateKeyFromEnv();
  if (privateKey === null) {
    console.error(
      "BUYER_PRIVATE_KEY is missing, placeholder, or invalid. Configure a " +
        "fresh testnet-only wallet before checking balances.",
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

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL?.trim();
  const client = createPublicClient({
    chain: baseSepolia,
    transport: rpcUrl ? http(rpcUrl) : http(),
  });

  const chainId = await client.getChainId();
  if (chainId !== EXPECTED_CHAIN_ID) {
    console.error(`RPC returned chainId=${chainId}; expected ${EXPECTED_CHAIN_ID}.`);
    process.exitCode = 1;
    return;
  }

  const [ethBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address: account.address }),
    client.readContract({
      address: BASE_SEPOLIA_USDC,
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
  console.log(`ETH status: ${ethOk ? "pass" : "missing Base Sepolia ETH for gas"}`);
  console.log(`USDC status: ${usdcOk ? "pass" : "missing at least 0.001 Base Sepolia USDC"}`);
  console.log("Payment execution: not performed by this script");

  process.exitCode = ethOk && usdcOk ? 0 : 1;
}

main().catch((error) => {
  console.error("[wallet:check] error:", (error as Error).message);
  process.exitCode = 1;
});
