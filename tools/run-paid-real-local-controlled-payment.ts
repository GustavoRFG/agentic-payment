/**
 * MVP 002D.1A - Controlled real-local payment gate.
 *
 * This is the future executor for one explicitly-approved Base Sepolia x402
 * payment over an actual sanitized local DeFi Guardian report. It is protected
 * by a hard confirmation token and is NOT run as part of the readiness task.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MAINNET_NETWORKS,
  MAX_PAYMENT_ATTEMPTS,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  PAYMENT_PRICE_LABEL,
  TESTNET_NETWORK,
  sanitizeEnv,
} from "../seller-api/src/config/safety.ts";
import { parseDefiGuardianSnapshotV1Json } from "../seller-api/src/adapters/defi-guardian/defiGuardianSnapshotV1.ts";
import type { RiskReportRequest } from "../seller-api/src/adapters/defi-guardian/reportTypes.ts";

const CONFIRM_TOKEN = "ONE_BASE_SEPOLIA_PAYMENT";
const PORT = 4021;
const BASE_URL = `http://localhost:${PORT}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const NETWORK = TESTNET_NETWORK;
const ASSET = PAYMENT_ASSET;
const AMOUNT_ATOMIC = PAYMENT_AMOUNT_ATOMIC;
const AMOUNT_USD = PAYMENT_AMOUNT_USD;
const MAX_ATTEMPTS = MAX_PAYMENT_ATTEMPTS;

type ResultKind = "CONTROLLED_PAYMENT_SUCCEEDED" | "PAYMENT_NOT_AUTHORIZED" | "BLOCKED" | "CONTROLLED_PAYMENT_FAILED";
type StepState = "OK" | "FAILED" | "SKIPPED";

interface ControlledState {
  authorized: boolean;
  snapshotRefresh: StepState;
  snapshotValidate: StepState;
  walletCheck: StepState;
  portCheck: StepState;
  health: StepState;
  publicRealFile: StepState;
  protectedUnpaid: StepState;
  payment: StepState;
  sellerStopped: boolean;
  paymentAttempts: number;
}

interface SelectedPosition {
  tokenId: string;
  protocol: string;
  chain: string;
  pair?: string;
  inRange: boolean;
  total: number;
}

interface AcceptEntry {
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  extra?: { name?: string };
}

class ControlledPaymentError extends Error {
  constructor(readonly result: ResultKind, message: string) {
    super(message);
  }
}

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function spawnNpm(args: string[], options: Parameters<typeof spawn>[2]): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", npmCommand(), ...args], options);
  }
  return spawn(npmCommand(), args, options);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function snapshotPath(root: string): string {
  return resolve(root, "runtime", "defi-guardian-snapshots", "latest.json");
}

function sanitizedBaseEnv(): NodeJS.ProcessEnv {
  return sanitizeEnv();
}

function controlledDefaults(root: string): NodeJS.ProcessEnv {
  return {
    PORT: String(PORT),
    SELLER_BASE_URL: BASE_URL,
    REPORT_PRICE_USD: PAYMENT_PRICE_LABEL,
    X402_NETWORK: NETWORK,
    MAX_PAYMENT_USD: AMOUNT_USD,
    AGENTIC_AUDIT_LOG_DIR: join(root, "logs"),
  };
}

function sellerEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...sanitizedBaseEnv(),
    ...controlledDefaults(root),
    ...extra,
  };
}

function snapshotEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...sanitizedBaseEnv(),
    ...controlledDefaults(root),
    ...extra,
  };
}

function walletCheckEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...sanitizedBaseEnv(),
    ...controlledDefaults(root),
    ...extra,
  };
}

function buyerPaymentEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...sanitizedBaseEnv(),
    ...controlledDefaults(root),
    ...extra,
  };
}

function parseConfirmation(argv: readonly string[]): boolean {
  const index = argv.indexOf("--confirm");
  return index >= 0 && argv[index + 1] === CONFIRM_TOKEN;
}

function printNotAuthorized(): void {
  console.log("RESULT: PAYMENT_NOT_AUTHORIZED");
  console.log("Controlled payment script executed: No");
  console.log(`Required confirmation token: ${CONFIRM_TOKEN}`);
  console.log("x402 payment attempted: No");
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

function atomicUsdcToUsd(amountAtomic: string | undefined): string | undefined {
  if (!amountAtomic) return undefined;
  try {
    const atomic = BigInt(amountAtomic);
    const whole = atomic / 1_000_000n;
    const fractional = (atomic % 1_000_000n).toString().padStart(6, "0");
    return `${whole}.${fractional}`.replace(/\.?0+$/, "");
  } catch {
    return undefined;
  }
}

async function runCaptured(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnNpm(args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", (error) => rejectRun(error));
    child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
  });
}

async function refreshAndValidateSnapshot(root: string): Promise<void> {
  const result = await runCaptured(["run", "snapshot:refresh:local"], root, snapshotEnv(root));
  if (
    result.code !== 0 ||
    !result.output.includes("RESULT: AGENTIC_SNAPSHOT_EXPORTED") ||
    !result.output.includes("RESULT: SNAPSHOT_VALID")
  ) {
    throw new ControlledPaymentError("BLOCKED", "invalid local snapshot");
  }
  if (
    result.output.includes("Secrets detected: Yes") ||
    result.output.includes("Raw wallet addresses emitted: Yes") ||
    result.output.includes("RPC called: Yes") ||
    result.output.includes("MongoDB writes performed: Yes") ||
    result.output.includes("Transactions attempted: Yes")
  ) {
    throw new ControlledPaymentError("BLOCKED", "snapshot refresh violated a safety invariant");
  }
}

function loadValidateSelect(file: string): SelectedPosition {
  if (!existsSync(file)) {
    throw new ControlledPaymentError("BLOCKED", "missing local snapshot");
  }
  const parsed = parseDefiGuardianSnapshotV1Json(readFileSync(file, "utf8"));
  if (!parsed.ok) {
    throw new ControlledPaymentError("BLOCKED", "invalid local snapshot");
  }
  if (parsed.snapshot.positions.length === 0) {
    throw new ControlledPaymentError("BLOCKED", "invalid local snapshot");
  }
  const active = parsed.snapshot.positions.find((position) => position.inRange === true);
  const chosen = active ?? parsed.snapshot.positions[0];
  if (!chosen) {
    throw new ControlledPaymentError("BLOCKED", "invalid local snapshot");
  }
  return {
    tokenId: chosen.tokenId,
    protocol: chosen.protocol,
    chain: chosen.chain,
    pair: chosen.pair,
    inRange: chosen.inRange,
    total: parsed.snapshot.positions.length,
  };
}

async function checkWallet(root: string): Promise<void> {
  const buyerDir = join(root, "buyer-client");
  const result = await runCaptured(["run", "wallet:check"], buyerDir, walletCheckEnv(root));
  const output = result.output;
  if (!output.includes(`Network: ${NETWORK}`)) {
    throw new ControlledPaymentError("BLOCKED", "mainnet network");
  }
  if (!output.includes("Asset target: USDC Base Sepolia")) {
    throw new ControlledPaymentError("BLOCKED", "non-USDC asset");
  }
  if (!output.includes("Required USDC: 0.001 / 1000 atomic units")) {
    throw new ControlledPaymentError("BLOCKED", "amount other than 1000 atomic units");
  }
  if (!output.includes("ETH status: pass")) {
    throw new ControlledPaymentError("BLOCKED", "missing ETH gas balance");
  }
  if (!output.includes("USDC status: pass")) {
    throw new ControlledPaymentError("BLOCKED", "missing USDC balance");
  }
  if (result.code !== 0 || !output.includes("Payment execution: not performed by this script")) {
    throw new ControlledPaymentError("BLOCKED", "wallet readiness check failed");
  }
}

function demoRequest(selected: SelectedPosition): RiskReportRequest {
  return {
    wallet: ZERO_ADDRESS,
    position: {
      protocol: selected.protocol,
      chain: selected.chain,
      tokenId: selected.tokenId,
      ...(selected.pair ? { pair: selected.pair } : {}),
    },
  };
}

function startSeller(root: string, file: string): ChildProcessWithoutNullStreams {
  const sellerDir = join(root, "seller-api");
  const seller = spawnNpm(["run", "dev"], {
    cwd: sellerDir,
    env: sellerEnv(root, {
      DEFI_GUARDIAN_ADAPTER_MODE: "real-file",
      DEFI_GUARDIAN_SNAPSHOT_PATH: file,
    }),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  seller.stdout.on("data", (chunk) => (output += chunk.toString()));
  seller.stderr.on("data", (chunk) => (output += chunk.toString()));
  Object.defineProperty(seller, "__controlledOutput", { value: () => output, enumerable: false });
  return seller;
}

function sellerOutput(seller: ChildProcessWithoutNullStreams): string {
  const getter = (seller as unknown as { __controlledOutput?: () => string }).__controlledOutput;
  return getter ? getter() : "";
}

async function stopSeller(seller: ChildProcessWithoutNullStreams | null): Promise<boolean> {
  if (!seller || seller.exitCode !== null) return true;
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/PID", String(seller.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("close", () => resolveKill());
      killer.on("error", () => resolveKill());
    });
  } else {
    seller.kill("SIGTERM");
  }
  await delay(500);
  return seller.exitCode !== null || seller.killed;
}

async function waitForHealth(seller: ChildProcessWithoutNullStreams): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (seller.exitCode !== null) {
      throw new ControlledPaymentError("BLOCKED", "seller failed to start");
    }
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.status === 200) return;
    } catch {
      // Still starting.
    }
    await delay(500);
  }
  if (sellerOutput(seller).includes("eip155:1") || sellerOutput(seller).includes("eip155:8453")) {
    throw new ControlledPaymentError("BLOCKED", "mainnet network");
  }
  throw new ControlledPaymentError("BLOCKED", "seller health check timed out");
}

async function postPublicRealFileReport(selected: SelectedPosition, timestamp: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/mock/defi-risk-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": `controlled-real-local-public-${timestamp}` },
    body: JSON.stringify(demoRequest(selected)),
  });
  const body = (await response.json()) as {
    mode?: unknown;
    adapter?: { requestedMode?: unknown; resolvedMode?: unknown; fallbackUsed?: unknown; snapshotVersion?: unknown };
    position?: { tokenId?: unknown };
  };
  if (
    response.status !== 200 ||
    body.mode !== "adapter-real-file" ||
    body.adapter?.requestedMode !== "adapter-real-file" ||
    body.adapter?.resolvedMode !== "adapter-real-file" ||
    body.adapter?.fallbackUsed !== false ||
    body.adapter?.snapshotVersion !== "defi-guardian-snapshot-v1" ||
    body.position?.tokenId !== selected.tokenId
  ) {
    throw new ControlledPaymentError("BLOCKED", "public real-local report validation failed");
  }
}

async function postProtectedUnpaid(selected: SelectedPosition, timestamp: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/paid/defi-risk-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": `controlled-real-local-unpaid-${timestamp}` },
    body: JSON.stringify(demoRequest(selected)),
  });
  if (response.status !== 402) {
    throw new ControlledPaymentError("BLOCKED", "protected endpoint did not return HTTP 402 before payment");
  }
  const raw = response.headers.get("payment-required") ?? "";
  if (!raw) {
    throw new ControlledPaymentError("BLOCKED", "protected endpoint returned HTTP 402 without payment requirements");
  }
  let accept: AcceptEntry | undefined;
  try {
    const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as { accepts?: AcceptEntry[] };
    accept = envelope.accepts?.[0];
  } catch {
    throw new ControlledPaymentError("BLOCKED", "invalid payment requirements");
  }
  if (!accept) {
    throw new ControlledPaymentError("BLOCKED", "invalid payment requirements");
  }
  const amountAtomic = accept.amount ?? accept.maxAmountRequired;
  const amountUsd = atomicUsdcToUsd(amountAtomic);
  const asset = accept.extra?.name ?? "";
  if (MAINNET_NETWORKS.has(String(accept.network))) {
    throw new ControlledPaymentError("BLOCKED", "mainnet network");
  }
  if (accept.network !== NETWORK) {
    throw new ControlledPaymentError("BLOCKED", "mainnet network");
  }
  if (asset !== ASSET) {
    throw new ControlledPaymentError("BLOCKED", "non-USDC asset");
  }
  if (amountAtomic !== AMOUNT_ATOMIC) {
    throw new ControlledPaymentError("BLOCKED", "amount other than 1000 atomic units");
  }
  if (amountUsd !== AMOUNT_USD || Number(amountUsd) > Number(AMOUNT_USD)) {
    throw new ControlledPaymentError("BLOCKED", "amount greater than $0.001");
  }
}

async function runBuyerPaymentOnce(root: string, selected: SelectedPosition): Promise<void> {
  const buyerDir = join(root, "buyer-client");
  const result = await runCaptured(
    ["run", "dev", "--", "--pay"],
    buyerDir,
    buyerPaymentEnv(root, {
      BUYER_REPORT_PROTOCOL: selected.protocol,
      BUYER_REPORT_CHAIN: selected.chain,
      BUYER_REPORT_TOKEN_ID: selected.tokenId,
      ...(selected.pair ? { BUYER_REPORT_PAIR: selected.pair } : {}),
    }),
  );
  if (result.output.includes("dry-run OK. No payment attempted.")) {
    throw new ControlledPaymentError("CONTROLLED_PAYMENT_FAILED", "buyer unexpectedly ran in dry-run mode");
  }
  if (result.code !== 0 || !result.output.includes("final response HTTP 200")) {
    throw new ControlledPaymentError("CONTROLLED_PAYMENT_FAILED", "buyer payment path failed");
  }
  if (!result.output.includes("adapter-real-file") || !result.output.includes(selected.tokenId)) {
    throw new ControlledPaymentError("CONTROLLED_PAYMENT_FAILED", "paid report did not match selected real-local token");
  }
}

function printSummary(
  result: ResultKind,
  state: ControlledState,
  selected: SelectedPosition | null,
  error?: unknown,
): void {
  console.log("");
  console.log(`RESULT: ${result}`);
  if (result !== "CONTROLLED_PAYMENT_SUCCEEDED" && error instanceof Error) {
    console.log(`Gate error: ${error.message}`);
  }
  console.log(`Snapshot refresh: ${state.snapshotRefresh}`);
  console.log(`Snapshot validate: ${state.snapshotValidate}`);
  console.log(`Wallet check: ${state.walletCheck}`);
  console.log(`Port 4021 check: ${state.portCheck}`);
  console.log(`Selected active token: ${selected ? "Yes" : "No"}`);
  console.log(`Public report: ${state.publicRealFile}`);
  console.log(`Protected endpoint unpaid: ${state.protectedUnpaid === "OK" ? "HTTP 402" : state.protectedUnpaid}`);
  console.log(`Payment execution: ${state.payment}`);
  console.log(`Seller stopped: ${state.sellerStopped ? "Yes" : "No"}`);
  console.log(`Maximum payment attempts: ${MAX_ATTEMPTS}`);
  console.log(`Payment attempts used: ${state.paymentAttempts}`);
  console.log(`Network: ${NETWORK}`);
  console.log(`Asset: ${ASSET}`);
  console.log(`Amount atomic: ${AMOUNT_ATOMIC}`);
  console.log(`Amount USD: ${AMOUNT_USD}`);
  console.log("Mainnet used: No");
  console.log("USDT payment rail used: No");
  console.log("Raw wallet address printed: No");
}

async function main(): Promise<number> {
  if (!parseConfirmation(process.argv.slice(2))) {
    printNotAuthorized();
    return 2;
  }

  const root = projectRoot();
  const file = snapshotPath(root);
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const state: ControlledState = {
    authorized: true,
    snapshotRefresh: "SKIPPED",
    snapshotValidate: "SKIPPED",
    walletCheck: "SKIPPED",
    portCheck: "SKIPPED",
    health: "SKIPPED",
    publicRealFile: "SKIPPED",
    protectedUnpaid: "SKIPPED",
    payment: "SKIPPED",
    sellerStopped: false,
    paymentAttempts: 0,
  };
  let seller: ChildProcessWithoutNullStreams | null = null;
  let selected: SelectedPosition | null = null;
  let result: ResultKind = "CONTROLLED_PAYMENT_SUCCEEDED";
  let failure: unknown;

  try {
    await refreshAndValidateSnapshot(root);
    state.snapshotRefresh = "OK";
    state.snapshotValidate = "OK";

    selected = loadValidateSelect(file);

    await checkWallet(root);
    state.walletCheck = "OK";

    if (!(await isPortAvailable(PORT))) {
      throw new ControlledPaymentError("BLOCKED", "port 4021 already in use");
    }
    state.portCheck = "OK";

    seller = startSeller(root, file);
    await waitForHealth(seller);
    state.health = "OK";

    await postPublicRealFileReport(selected, timestamp);
    state.publicRealFile = "OK";

    await postProtectedUnpaid(selected, timestamp);
    state.protectedUnpaid = "OK";

    state.paymentAttempts += 1;
    await runBuyerPaymentOnce(root, selected);
    state.payment = "OK";
  } catch (error) {
    failure = error;
    result = error instanceof ControlledPaymentError ? error.result : "CONTROLLED_PAYMENT_FAILED";
    if (state.snapshotRefresh === "SKIPPED") state.snapshotRefresh = "FAILED";
    else if (state.walletCheck === "SKIPPED") state.walletCheck = "FAILED";
    else if (state.portCheck === "SKIPPED") state.portCheck = "FAILED";
    else if (state.publicRealFile === "SKIPPED") state.publicRealFile = "FAILED";
    else if (state.protectedUnpaid === "SKIPPED") state.protectedUnpaid = "FAILED";
    else if (state.payment === "SKIPPED") state.payment = "FAILED";
  } finally {
    await delay(500);
    state.sellerStopped = await stopSeller(seller);
  }

  printSummary(result, state, selected, failure);
  return result === "CONTROLLED_PAYMENT_SUCCEEDED" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
