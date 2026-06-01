/**
 * MVP 002D.0 — Optional paid-report real-local source, dry-run only.
 *
 * Proves that the x402-protected paid endpoint can be configured to serve an
 * actual sanitized local DeFi Guardian snapshot report while preserving every
 * safety invariant of the lab:
 *
 *   - mock mode remains the public-demo default (this is an opt-in override);
 *   - no x402 payment is ever executed (buyer runs --dry-run only);
 *   - no signing, no broadcast, no mainnet, no USDT rail;
 *   - no raw wallet addresses are printed (alias only);
 *   - the seller never reads MongoDB or calls RPC (it reads the local snapshot);
 *   - the DeFi Guardian watcher is never started.
 *
 * Flow:
 *   runtime/defi-guardian-snapshots/latest.json   (defi-guardian-snapshot-v1)
 *     → validate + parse safely
 *     → select one active position by tokenId (alias only)
 *     → seller-api with adapter-real-file + that snapshot
 *     → POST /mock/defi-risk-report (public real-file report) → HTTP 200
 *     → POST /paid/defi-risk-report WITHOUT payment → HTTP 402 Payment Required
 *     → buyer-client --dry-run against the protected endpoint
 *     → dashboard render
 *
 * This script never executes a payment. It is read-only with respect to the
 * snapshot and never touches .env or secrets.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDefiGuardianSnapshotV1Json } from "../seller-api/src/domain/defiGuardianSnapshotV1.ts";
import type { RiskReportRequest } from "../seller-api/src/domain/reportTypes.ts";

const PORT = 4021;
const BASE_URL = `http://localhost:${PORT}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EXPECTED_NETWORK = "eip155:84532";
const EXPECTED_ASSET = "USDC";
const EXPECTED_AMOUNT_ATOMIC = "1000";
const EXPECTED_AMOUNT_USD = "0.001";

type ResultKind = "PAID_REAL_LOCAL_DRY_RUN_SUCCEEDED" | "BLOCKED" | "DEMO_FAILED";
type StepState = "OK" | "FAILED" | "SKIPPED";

interface DemoState {
  snapshot: StepState;
  health: StepState;
  publicRealFile: StepState;
  protectedUnpaid: StepState;
  buyerDryRun: StepState;
  render: StepState;
  sellerStopped: boolean;
}

class DemoError extends Error {
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
  return new Promise((r) => setTimeout(r, ms));
}
function tail(text: string, max = 2400): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}
function snapshotPath(root: string): string {
  return resolve(root, "runtime", "defi-guardian-snapshots", "latest.json");
}
function safeChildEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const baseEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key || key.startsWith("=") || typeof value !== "string") continue;
    baseEnv[key] = value;
  }
  return {
    ...baseEnv,
    // Empty secret overrides: the seller and buyer must never receive real keys
    // in a dry-run. These deliberately blank out anything inherited from .env.
    BUYER_PRIVATE_KEY: "",
    CDP_API_KEY_ID: "",
    CDP_API_KEY_SECRET: "",
    CDP_WALLET_SECRET: "",
    PORT: String(PORT),
    SELLER_BASE_URL: BASE_URL,
    SELLER_RECEIVER_ADDRESS: ZERO_ADDRESS,
    REPORT_PRICE_USD: "$0.001",
    X402_NETWORK: EXPECTED_NETWORK,
    MAX_PAYMENT_USD: EXPECTED_AMOUNT_USD,
    AGENTIC_AUDIT_LOG_DIR: join(root, "logs"),
    ...extra,
  };
}

interface SelectedPosition {
  tokenId: string;
  alias: string;
  inRange: boolean;
  total: number;
}

// Step 2-4: validate the local snapshot with the existing validator, parse it
// safely, and select one active position by tokenId. Prefers an in-range
// ("active") position; falls back to the first position. Never exposes a raw
// wallet address — only the sanitized alias travels onward.
function loadValidateSelect(file: string): SelectedPosition {
  if (!existsSync(file)) {
    throw new DemoError(
      "BLOCKED",
      `local snapshot not found: ${file} (run "npm run snapshot:refresh:local" first).`,
    );
  }
  const raw = readFileSync(file, "utf8");
  const result = parseDefiGuardianSnapshotV1Json(raw);
  if (!result.ok) {
    throw new DemoError("BLOCKED", `local snapshot failed validation: ${result.errors.join("; ")}`);
  }
  if (result.snapshot.positions.length === 0) {
    throw new DemoError("BLOCKED", "local snapshot has no positions to demo.");
  }
  const active = result.snapshot.positions.find((p) => p.inRange === true);
  const chosen = active ?? result.snapshot.positions[0];
  return {
    tokenId: chosen.tokenId,
    alias: typeof chosen.walletAlias === "string" ? chosen.walletAlias : "(no alias)",
    inRange: chosen.inRange,
    total: result.snapshot.positions.length,
  };
}

function startSeller(root: string, runtimeCwd: string, file: string): ChildProcessWithoutNullStreams {
  // Step 6: safe env overrides — adapter-real-file + the absolute snapshot path,
  // testnet network, $0.001 price/cap, and blank secret overrides.
  const seller = spawnNpm(
    ["--prefix", join(root, "seller-api"), "exec", "--", "tsx", join(root, "seller-api", "src", "server.ts")],
    {
      cwd: runtimeCwd,
      env: safeChildEnv(root, {
        DEFI_GUARDIAN_ADAPTER_MODE: "real-file",
        DEFI_GUARDIAN_SNAPSHOT_PATH: file,
      }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  seller.stdout.on("data", (c) => (output += c.toString()));
  seller.stderr.on("data", (c) => (output += c.toString()));
  seller.on("error", (e) => (output += `\n${e.message}`));
  Object.defineProperty(seller, "__demoOutput", { value: () => output, enumerable: false });
  return seller;
}
function sellerOutput(seller: ChildProcessWithoutNullStreams): string {
  const getter = (seller as unknown as { __demoOutput?: () => string }).__demoOutput;
  return getter ? getter() : "";
}
async function stopSeller(seller: ChildProcessWithoutNullStreams | null): Promise<boolean> {
  if (!seller || seller.exitCode !== null) return true;
  if (process.platform === "win32") {
    await new Promise<void>((r) => {
      const killer = spawn("taskkill", ["/PID", String(seller.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("close", () => r());
      killer.on("error", () => r());
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
      throw new DemoError("BLOCKED", `seller failed to start.\n${tail(sellerOutput(seller))}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.status === 200) return;
    } catch {
      /* still starting */
    }
    await delay(500);
  }
  throw new DemoError("BLOCKED", `seller health check timed out.\n${tail(sellerOutput(seller))}`);
}

function demoRequest(tokenId: string): RiskReportRequest {
  return { wallet: ZERO_ADDRESS, position: { protocol: "pancakeswap-v3", chain: "bsc", tokenId } };
}

// Step 8: public real-file report over the actual local snapshot.
async function postPublicRealFileReport(
  tokenId: string,
  timestamp: string,
): Promise<{ riskScore: number; action: string }> {
  const response = await fetch(`${BASE_URL}/mock/defi-risk-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": `paid-real-local-public-${timestamp}` },
    body: JSON.stringify(demoRequest(tokenId)),
  });
  const body = (await response.json()) as {
    mode?: unknown;
    adapter?: { requestedMode?: unknown; resolvedMode?: unknown; fallbackUsed?: unknown; snapshotVersion?: unknown };
    risk?: { score?: unknown };
    recommendation?: { action?: unknown };
  };
  if (response.status !== 200) {
    throw new DemoError("DEMO_FAILED", `public real-file endpoint returned HTTP ${response.status}.`);
  }
  if (
    body.mode !== "adapter-real-file" ||
    body.adapter?.requestedMode !== "adapter-real-file" ||
    body.adapter?.resolvedMode !== "adapter-real-file" ||
    body.adapter?.fallbackUsed !== false ||
    body.adapter?.snapshotVersion !== "defi-guardian-snapshot-v1" ||
    typeof body.risk?.score !== "number" ||
    typeof body.recommendation?.action !== "string"
  ) {
    throw new DemoError("DEMO_FAILED", "public report did not match the expected adapter-real-file shape.");
  }
  return { riskScore: body.risk.score, action: body.recommendation.action };
}

interface AcceptEntry {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  extra?: { name?: string };
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

// Step 9: call the protected endpoint WITHOUT any payment and confirm the seller
// short-circuits with HTTP 402 and advertises the expected testnet requirements.
// This decodes the PAYMENT-REQUIRED header exactly as the buyer-client does; it
// never signs, never sends a payment header, and never retries with payment.
async function postProtectedUnpaid(tokenId: string, timestamp: string): Promise<void> {
  const response = await fetch(`${BASE_URL}/paid/defi-risk-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": `paid-real-local-unpaid-${timestamp}` },
    body: JSON.stringify(demoRequest(tokenId)),
  });
  if (response.status !== 402) {
    throw new DemoError("DEMO_FAILED", `protected endpoint returned HTTP ${response.status}, expected 402.`);
  }
  const raw = response.headers.get("payment-required") ?? "";
  if (!raw) {
    throw new DemoError("DEMO_FAILED", "protected endpoint returned 402 without a PAYMENT-REQUIRED header.");
  }
  let accept: AcceptEntry | undefined;
  try {
    const envelope = JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as { accepts?: AcceptEntry[] };
    accept = envelope.accepts?.[0];
  } catch {
    throw new DemoError("DEMO_FAILED", "failed to decode the PAYMENT-REQUIRED header.");
  }
  if (!accept) {
    throw new DemoError("DEMO_FAILED", "PAYMENT-REQUIRED header had no accepts entry.");
  }
  const amountAtomic = accept.amount ?? accept.maxAmountRequired;
  const asset = accept.extra?.name ?? "USDC";
  const amountUsd = atomicUsdcToUsd(amountAtomic);
  if (accept.network !== EXPECTED_NETWORK) {
    throw new DemoError("DEMO_FAILED", `402 network=${accept.network}, expected ${EXPECTED_NETWORK}.`);
  }
  if (asset !== EXPECTED_ASSET) {
    throw new DemoError("DEMO_FAILED", `402 asset=${asset}, expected ${EXPECTED_ASSET}.`);
  }
  if (amountAtomic !== EXPECTED_AMOUNT_ATOMIC) {
    throw new DemoError("DEMO_FAILED", `402 amountAtomic=${amountAtomic}, expected ${EXPECTED_AMOUNT_ATOMIC}.`);
  }
  if (amountUsd !== EXPECTED_AMOUNT_USD) {
    throw new DemoError("DEMO_FAILED", `402 amountUsd=${amountUsd}, expected ${EXPECTED_AMOUNT_USD}.`);
  }
  console.log(
    `Protected endpoint unpaid: HTTP 402 network=${accept.network} asset=${asset} ` +
      `amountAtomic=${amountAtomic} amountUsd=${amountUsd}`,
  );
}

// Step 10: buyer-client --dry-run against the protected endpoint. Validates that
// the buyer observes the 402 and stops without attempting payment.
async function runBuyerDryRun(root: string, runtimeCwd: string): Promise<void> {
  const output = await new Promise<string>((resolveRun, rejectRun) => {
    const child = spawnNpm(
      [
        "--prefix",
        join(root, "buyer-client"),
        "exec",
        "--",
        "tsx",
        join(root, "buyer-client", "src", "call-paid-report.ts"),
        "--dry-run",
      ],
      { cwd: runtimeCwd, env: safeChildEnv(root), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("error", (e) => rejectRun(new DemoError("DEMO_FAILED", `buyer dry-run failed: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolveRun(out) : rejectRun(new DemoError("DEMO_FAILED", `buyer dry-run exited ${code}.\n${tail(out)}`)),
    );
  });
  const markers = [
    "received HTTP 402",
    `network:         ${EXPECTED_NETWORK}`,
    `amount (atomic): ${EXPECTED_AMOUNT_ATOMIC}`,
    EXPECTED_ASSET,
    "dry-run OK. No payment attempted.",
  ];
  for (const marker of markers) {
    if (!output.includes(marker)) {
      throw new DemoError("DEMO_FAILED", `buyer dry-run output missing expected marker: ${marker}`);
    }
  }
  if (output.includes("signing one")) {
    throw new DemoError("DEMO_FAILED", "buyer dry-run output indicates signing; refusing demo result.");
  }
}

async function runDashboardRender(root: string): Promise<void> {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawnNpm(["run", "dashboard:render"], {
      cwd: root,
      env: safeChildEnv(root),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("error", (e) => rejectRun(new DemoError("DEMO_FAILED", `dashboard render failed: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolveRun() : rejectRun(new DemoError("DEMO_FAILED", `dashboard render exited ${code}.\n${tail(out)}`)),
    );
  });
}

function printSummary(
  result: ResultKind,
  state: DemoState,
  selected: SelectedPosition | null,
  error?: unknown,
): void {
  console.log("");
  console.log(`RESULT: ${result}`);
  if (result !== "PAID_REAL_LOCAL_DRY_RUN_SUCCEEDED" && error instanceof Error) {
    console.log(`Demo error: ${error.message}`);
  }
  console.log("");
  console.log(`Snapshot: ${state.snapshot === "OK" ? "valid" : state.snapshot}`);
  console.log(`Selected alias: ${selected ? selected.alias : "(none)"}`);
  console.log(`Selected tokenId: ${selected ? selected.tokenId : "(none)"}`);
  console.log(`Public real-file report: ${state.publicRealFile}`);
  console.log(
    `Protected endpoint unpaid response: ${state.protectedUnpaid === "OK" ? "HTTP 402" : state.protectedUnpaid}`,
  );
  console.log(`Buyer dry-run: ${state.buyerDryRun}`);
  console.log(`Dashboard render: ${state.render === "OK" ? "OK" : state.render}`);
  console.log(`Seller stopped: ${state.sellerStopped ? "Yes" : "No"}`);
  console.log("x402 payment attempted: No");
  console.log("Mainnet used: No");
  console.log("USDT payment rail used: No");
  console.log("Secrets touched: No");
  console.log("Raw wallet address printed: No");
  console.log("MongoDB writes performed: No");
  console.log("RPC called: No");
}

async function main(): Promise<number> {
  const root = projectRoot();
  const file = snapshotPath(root);
  const runtimeCwd = mkdtempSync(join(tmpdir(), "agentic-payments-lab-paid-real-local-"));
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const state: DemoState = {
    snapshot: "SKIPPED",
    health: "SKIPPED",
    publicRealFile: "SKIPPED",
    protectedUnpaid: "SKIPPED",
    buyerDryRun: "SKIPPED",
    render: "SKIPPED",
    sellerStopped: false,
  };
  let seller: ChildProcessWithoutNullStreams | null = null;
  let result: ResultKind = "PAID_REAL_LOCAL_DRY_RUN_SUCCEEDED";
  let selected: SelectedPosition | null = null;
  let failure: unknown;

  try {
    selected = loadValidateSelect(file);
    state.snapshot = "OK";
    console.log(
      `Snapshot valid: ${selected.total} position(s); selected tokenId=${selected.tokenId} ` +
        `alias=${selected.alias} inRange=${selected.inRange}`,
    );

    if (!(await isPortAvailable(PORT))) {
      throw new DemoError("BLOCKED", `port ${PORT} is already in use before the demo starts.`);
    }

    seller = startSeller(root, runtimeCwd, file);
    await waitForHealth(seller);
    state.health = "OK";

    const report = await postPublicRealFileReport(selected.tokenId, timestamp);
    state.publicRealFile = "OK";
    console.log(`Public real-file report OK: riskScore=${report.riskScore} recommendation=${report.action}`);

    await postProtectedUnpaid(selected.tokenId, timestamp);
    state.protectedUnpaid = "OK";

    await runBuyerDryRun(root, runtimeCwd);
    state.buyerDryRun = "OK";

    await runDashboardRender(root);
    state.render = "OK";
  } catch (error) {
    failure = error;
    result = error instanceof DemoError ? error.result : "DEMO_FAILED";
    if (state.snapshot === "SKIPPED") state.snapshot = "FAILED";
    else if (state.publicRealFile === "SKIPPED") state.publicRealFile = "FAILED";
    else if (state.protectedUnpaid === "SKIPPED") state.protectedUnpaid = "FAILED";
    else if (state.buyerDryRun === "SKIPPED") state.buyerDryRun = "FAILED";
    else if (state.render === "SKIPPED") state.render = "FAILED";
  } finally {
    await delay(500);
    state.sellerStopped = await stopSeller(seller);
  }

  printSummary(result, state, selected, failure);
  return result === "PAID_REAL_LOCAL_DRY_RUN_SUCCEEDED" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
