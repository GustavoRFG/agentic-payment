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
const EXPECTED_AMOUNT_USD = "0.001";

type ResultKind = "REAL_LOCAL_FILE_DEMO_SUCCEEDED" | "BLOCKED" | "DEMO_FAILED";

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
  total: number;
}

function loadAndValidateSnapshot(file: string): SelectedPosition {
  if (!existsSync(file)) {
    throw new DemoError("BLOCKED", `local snapshot not found: ${file} (run snapshot:export:local first).`);
  }
  const raw = readFileSync(file, "utf8");
  const result = parseDefiGuardianSnapshotV1Json(raw);
  if (!result.ok) {
    throw new DemoError("BLOCKED", `local snapshot failed validation: ${result.errors.join("; ")}`);
  }
  if (result.snapshot.positions.length === 0) {
    throw new DemoError("BLOCKED", "local snapshot has no positions to demo.");
  }
  const first = result.snapshot.positions[0];
  return {
    tokenId: first.tokenId,
    alias: typeof first.walletAlias === "string" ? first.walletAlias : "(no alias)",
    total: result.snapshot.positions.length,
  };
}

function startSeller(root: string, runtimeCwd: string, file: string): ChildProcessWithoutNullStreams {
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
async function postRealFileReport(tokenId: string, timestamp: string): Promise<{ riskScore: number; action: string }> {
  const response = await fetch(`${BASE_URL}/mock/defi-risk-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": `real-local-demo-${timestamp}` },
    body: JSON.stringify(demoRequest(tokenId)),
  });
  const body = (await response.json()) as {
    mode?: unknown;
    adapter?: { requestedMode?: unknown; resolvedMode?: unknown; fallbackUsed?: unknown; snapshotVersion?: unknown };
    risk?: { score?: unknown };
    recommendation?: { action?: unknown };
  };
  if (response.status !== 200) {
    throw new DemoError("DEMO_FAILED", `real-file endpoint returned HTTP ${response.status}.`);
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
    throw new DemoError("DEMO_FAILED", "real-local response did not match the expected adapter-real-file shape.");
  }
  return { riskScore: body.risk.score, action: body.recommendation.action };
}
async function runCommand(label: string, cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolveCommand, rejectCommand) => {
    const child = spawnNpm(args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString()));
    child.stderr.on("data", (c) => (out += c.toString()));
    child.on("error", (e) => rejectCommand(new DemoError("DEMO_FAILED", `${label} failed: ${e.message}`)));
    child.on("close", (code) =>
      code === 0 ? resolveCommand() : rejectCommand(new DemoError("DEMO_FAILED", `${label} exited ${code}.\n${tail(out)}`)),
    );
  });
}

function printSummary(result: ResultKind, selected: SelectedPosition | null, report: { riskScore: number; action: string } | null, sellerStopped: boolean, error?: unknown): void {
  console.log("");
  console.log(`RESULT: ${result}`);
  if (result !== "REAL_LOCAL_FILE_DEMO_SUCCEEDED" && error instanceof Error) {
    console.log(`Demo error: ${error.message}`);
  }
  console.log(`Snapshot positions: ${selected ? selected.total : 0}`);
  console.log(`Selected position alias: ${selected ? selected.alias : "(none)"}`);
  console.log(`Selected tokenId: ${selected ? selected.tokenId : "(none)"}`);
  console.log(`Risk score: ${report ? report.riskScore : "(n/a)"}`);
  console.log(`Recommendation: ${report ? report.action : "(n/a)"}`);
  console.log(`Seller stopped: ${sellerStopped ? "Yes" : "No"}`);
  console.log("x402 payment attempted: No");
  console.log("Mainnet used: No");
  console.log("USDT used: No");
  console.log("Secrets touched: No");
  console.log("Raw wallet address printed: No");
}

async function main(): Promise<number> {
  const root = projectRoot();
  const file = snapshotPath(root);
  const runtimeCwd = mkdtempSync(join(tmpdir(), "agentic-payments-lab-real-local-"));
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  let seller: ChildProcessWithoutNullStreams | null = null;
  let result: ResultKind = "REAL_LOCAL_FILE_DEMO_SUCCEEDED";
  let selected: SelectedPosition | null = null;
  let report: { riskScore: number; action: string } | null = null;
  let failure: unknown;
  let sellerStopped = false;

  try {
    selected = loadAndValidateSnapshot(file);
    if (!(await isPortAvailable(PORT))) {
      throw new DemoError("BLOCKED", `port ${PORT} is already in use before the demo starts.`);
    }
    seller = startSeller(root, runtimeCwd, file);
    await waitForHealth(seller);
    report = await postRealFileReport(selected.tokenId, timestamp);
    await runCommand("dashboard render", root, ["run", "dashboard:render"], safeChildEnv(root));
  } catch (error) {
    failure = error;
    result = error instanceof DemoError ? error.result : "DEMO_FAILED";
  } finally {
    await delay(500);
    sellerStopped = await stopSeller(seller);
  }

  printSummary(result, selected, report, sellerStopped, failure);
  return result === "REAL_LOCAL_FILE_DEMO_SUCCEEDED" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
