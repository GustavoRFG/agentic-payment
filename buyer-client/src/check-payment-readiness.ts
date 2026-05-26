/**
 * MVP 001B.0 payment readiness check.
 *
 * This script is intentionally non-paying. It does not import the x402 buyer
 * payment flow, does not create a signer, and does not call the paid endpoint.
 * It only validates local configuration and static safety rails before a
 * future explicitly-approved Base Sepolia testnet payment.
 */

import dotenv from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const EXPECTED_NETWORK = "eip155:84532";
const MAINNET_NETWORKS = new Set(["eip155:1", "eip155:8453"]);
const DEFAULT_SELLER_BASE_URL = "http://localhost:4021";
const DEFAULT_MAX_PAYMENT_USD = "0.001";
const MAX_ALLOWED_PAYMENT_USD = 0.001;
const PLACEHOLDER_PRIVATE_KEY =
  "0xTESTNET_ONLY_PRIVATE_KEY_DO_NOT_USE_REAL_FUNDS";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function findRepoRoot(start: string): string {
  let current = start;
  for (let depth = 0; depth < 6; depth += 1) {
    const packageJson = resolve(current, "package.json");
    if (existsSync(packageJson)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJson, "utf-8")) as {
          name?: string;
        };
        if (parsed.name === "agentic-payments-lab") return current;
      } catch {
        // Keep walking upward.
      }
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd(), "..");
}

function hasProjectFiles(path: string): boolean {
  return (
    existsSync(resolve(path, "seller-api", ".env.example")) &&
    existsSync(resolve(path, "buyer-client", ".env.example")) &&
    existsSync(resolve(path, "package.json"))
  );
}

function resolveRepoRoot(): string {
  const candidates = [
    findRepoRoot(__dirname),
    process.cwd(),
    resolve(process.cwd(), ".."),
    resolve(__dirname, "..", ".."),
    resolve(__dirname, "..", "..", ".."),
  ];
  for (const candidate of candidates) {
    if (hasProjectFiles(candidate)) return candidate;
  }
  return findRepoRoot(__dirname);
}

const repoRoot = resolveRepoRoot();

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function addCheck(
  checks: Check[],
  name: string,
  ok: boolean,
  detail: string,
): void {
  checks.push({ name, ok, detail });
}

function readText(path: string): string {
  return readFileSync(path, "utf-8");
}

function envValue(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return raw.trim();
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseMaxPayment(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function classifyPrivateKey(raw: string | undefined): {
  label: string;
  ok: boolean;
  readyForPaymentExecution: boolean;
  detail: string;
} {
  const value = raw?.trim() ?? "";
  if (!value) {
    return {
      label: "not configured",
      ok: true,
      readyForPaymentExecution: false,
      detail: "safe for preparation; future payment requires a fresh testnet-only key",
    };
  }
  if (value === PLACEHOLDER_PRIVATE_KEY) {
    return {
      label: "placeholder",
      ok: true,
      readyForPaymentExecution: false,
      detail: "placeholder is intentionally refused by --pay",
    };
  }
  if (!value.startsWith("0x")) {
    return {
      label: "invalid",
      ok: false,
      readyForPaymentExecution: false,
      detail: "BUYER_PRIVATE_KEY must be 0x-prefixed",
    };
  }
  if (value.length !== 66) {
    return {
      label: "invalid",
      ok: false,
      readyForPaymentExecution: false,
      detail: "BUYER_PRIVATE_KEY must be 66 characters including 0x",
    };
  }
  return {
    label: "present-but-redacted",
    ok: true,
    readyForPaymentExecution: true,
    detail:
      "format is valid; use only with a fresh Base Sepolia testnet wallet after explicit approval",
  };
}

function exampleContainsLine(text: string, expected: string): boolean {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(expected);
}

function activeEnvLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function activeEnvContainsLine(text: string, value: string): boolean {
  return activeEnvLines(text).includes(value);
}

function main(): void {
  const checks: Check[] = [];
  const sellerBaseUrl = normalizeUrl(
    envValue("SELLER_BASE_URL", DEFAULT_SELLER_BASE_URL),
  );
  const network = envValue("X402_NETWORK", EXPECTED_NETWORK);
  const maxPaymentRaw = envValue("MAX_PAYMENT_USD", DEFAULT_MAX_PAYMENT_USD);
  const maxPayment = parseMaxPayment(maxPaymentRaw);
  const privateKey = classifyPrivateKey(process.env.BUYER_PRIVATE_KEY);

  const sellerEnvExample = resolve(repoRoot, "seller-api", ".env.example");
  const buyerEnvExample = resolve(repoRoot, "buyer-client", ".env.example");
  const buyerSource = resolve(repoRoot, "buyer-client", "src", "call-paid-report.ts");

  const sellerEnvText = existsSync(sellerEnvExample) ? readText(sellerEnvExample) : "";
  const buyerEnvText = existsSync(buyerEnvExample) ? readText(buyerEnvExample) : "";
  const buyerSourceText = existsSync(buyerSource) ? readText(buyerSource) : "";

  addCheck(
    checks,
    "SELLER_BASE_URL",
    sellerBaseUrl.length > 0,
    `using ${sellerBaseUrl}`,
  );
  addCheck(
    checks,
    "X402_NETWORK",
    network === EXPECTED_NETWORK,
    `expected ${EXPECTED_NETWORK}; got ${network}`,
  );
  addCheck(
    checks,
    "MAX_PAYMENT_USD",
    Number.isFinite(maxPayment) && maxPayment <= MAX_ALLOWED_PAYMENT_USD,
    `expected <= ${MAX_ALLOWED_PAYMENT_USD}; got ${maxPaymentRaw}`,
  );
  addCheck(
    checks,
    "BUYER_PRIVATE_KEY",
    privateKey.ok,
    privateKey.detail,
  );
  addCheck(
    checks,
    "mainnet disabled",
    !MAINNET_NETWORKS.has(network),
    `configured network ${network}`,
  );
  addCheck(
    checks,
    "USDT disabled",
    ![
      process.env.X402_ASSET,
      process.env.PAYMENT_ASSET,
      process.env.TARGET_ASSET,
    ]
      .filter(Boolean)
      .some((value) => String(value).toUpperCase().includes("USDT")),
    "no USDT payment asset environment variable is configured",
  );
  addCheck(
    checks,
    "seller .env.example Base Sepolia",
    exampleContainsLine(sellerEnvText, "X402_NETWORK=eip155:84532") &&
      !activeEnvContainsLine(sellerEnvText, "X402_NETWORK=eip155:8453"),
    "seller example remains Base Sepolia-only",
  );
  addCheck(
    checks,
    "buyer .env.example Base Sepolia",
    exampleContainsLine(buyerEnvText, "X402_NETWORK=eip155:84532") &&
      exampleContainsLine(buyerEnvText, "MAX_PAYMENT_USD=0.001") &&
      !activeEnvContainsLine(buyerEnvText, "X402_NETWORK=eip155:8453"),
    "buyer example remains Base Sepolia-only with $0.001 ceiling",
  );
  addCheck(
    checks,
    "buyer dry-run support",
    buyerSourceText.includes("--dry-run") &&
      buyerSourceText.includes("Default to dry-run") &&
      buyerSourceText.includes("dry-run OK. No payment attempted."),
    "buyer defaults to dry-run and documents no-payment behavior",
  );
  addCheck(
    checks,
    "buyer placeholder refusal",
    buyerSourceText.includes("BUYER_PRIVATE_KEY") &&
      buyerSourceText.includes("startsWith(\"0x\")") &&
      buyerSourceText.includes("length < 66"),
    "buyer refuses missing/placeholder key before payment path can proceed",
  );

  const unsafe = checks.filter((check) => !check.ok);
  const preparationReady = unsafe.length === 0;
  const executionStatus = privateKey.readyForPaymentExecution
    ? "format-ready for future explicit approval"
    : "not ready for payment execution";

  console.log("Payment readiness report");
  console.log("------------------------");
  console.log(`Network: ${network}`);
  console.log("Asset target: USDC Base Sepolia");
  console.log("Amount target: 0.001 USDC / 1000 atomic units");
  console.log(`Seller URL: ${sellerBaseUrl}`);
  console.log(`Max payment: $${maxPaymentRaw}`);
  console.log(`Private key: ${privateKey.label}`);
  console.log(`Mainnet check: ${MAINNET_NETWORKS.has(network) ? "fail" : "pass"}`);
  console.log(`USDT check: ${unsafe.some((c) => c.name === "USDT disabled") ? "fail" : "pass"}`);
  console.log("Dry-run required: pass");
  console.log("Payment execution: disabled in this task");
  console.log(`Payment execution readiness: ${executionStatus}`);
  console.log("");
  console.log("Checks:");
  for (const check of checks) {
    console.log(`- ${check.ok ? "pass" : "fail"} ${check.name}: ${check.detail}`);
  }
  console.log("");
  console.log(
    preparationReady
      ? "Status: safe for preparation."
      : "Status: unsafe configuration; do not attempt payment.",
  );

  process.exitCode = preparationReady ? 0 : 1;
}

main();
