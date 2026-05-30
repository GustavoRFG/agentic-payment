import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defiGuardianAdapter } from "../seller-api/src/domain/defiGuardianAdapter.ts";
import type { RiskReportRequest } from "../seller-api/src/domain/reportTypes.ts";

const PORT = 4021;
const BASE_URL = `http://localhost:${PORT}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EXPECTED_NETWORK = "eip155:84532";
const EXPECTED_AMOUNT_USD = "0.001";
const EXPECTED_AMOUNT_ATOMIC = "1000";

type ResultKind = "REAL_FILE_DEMO_SUCCEEDED" | "BLOCKED" | "DEMO_FAILED";
type StepState = "OK" | "FAILED" | "SKIPPED";

interface DemoState {
  fallback: StepState;
  health: StepState;
  realFileReport: StepState;
  dryRun: StepState;
  render: StepState;
  sellerStopped: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

class DemoError extends Error {
  constructor(
    readonly result: ResultKind,
    message: string,
  ) {
    super(message);
  }
}

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function spawnNpm(
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", npmCommand(), ...args], options);
  }
  return spawn(npmCommand(), args, options);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolvePort(true));
    });
  });
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

function tail(text: string, max = 2400): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

function runCommand(
  label: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawnNpm(args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      rejectCommand(new DemoError("DEMO_FAILED", `${label} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr });
        return;
      }
      rejectCommand(
        new DemoError(
          "DEMO_FAILED",
          `${label} exited with code ${code ?? "unknown"}.\n${tail(stdout + stderr)}`,
        ),
      );
    });
  });
}

function fixturePath(root: string): string {
  return join(
    root,
    "seller-api",
    "src",
    "fixtures",
    "defiGuardianSnapshotV1.sample.json",
  );
}

function startSeller(
  root: string,
  runtimeCwd: string,
  snapshotPath: string,
): ChildProcessWithoutNullStreams {
  const seller = spawnNpm(
    [
      "--prefix",
      join(root, "seller-api"),
      "exec",
      "--",
      "tsx",
      join(root, "seller-api", "src", "server.ts"),
    ],
    {
      cwd: runtimeCwd,
      env: safeChildEnv(root, {
        DEFI_GUARDIAN_ADAPTER_MODE: "real-file",
        DEFI_GUARDIAN_SNAPSHOT_PATH: snapshotPath,
      }),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  seller.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  seller.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  seller.on("error", (error) => {
    output += `\n${error.message}`;
  });
  Object.defineProperty(seller, "__demoOutput", {
    value: () => output,
    enumerable: false,
  });
  return seller;
}

function sellerOutput(seller: ChildProcessWithoutNullStreams): string {
  const getter = (seller as unknown as { __demoOutput?: () => string }).__demoOutput;
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
      throw new DemoError("BLOCKED", `seller failed to start.\n${tail(sellerOutput(seller))}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/health`);
      if (response.status === 200) return;
    } catch {
      // Server may still be starting.
    }
    await delay(500);
  }
  throw new DemoError("BLOCKED", `seller health check timed out.\n${tail(sellerOutput(seller))}`);
}

function demoRequest(tokenId = "demo-real-file-001"): RiskReportRequest {
  return {
    wallet: ZERO_ADDRESS,
    position: {
      protocol: "pancakeswap-v3",
      chain: "bsc",
      tokenId,
    },
  };
}

async function postRealFileReport(timestamp: string): Promise<{ riskScore: number; action: string }> {
  const response = await fetch(`${BASE_URL}/mock/defi-risk-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": `real-file-demo-${timestamp}`,
    },
    body: JSON.stringify(demoRequest()),
  });
  const body = (await response.json()) as {
    mode?: unknown;
    adapter?: {
      requestedMode?: unknown;
      resolvedMode?: unknown;
      fallbackUsed?: unknown;
      snapshotVersion?: unknown;
      source?: unknown;
    };
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
    body.adapter?.source !== "local-sanitized-json" ||
    typeof body.risk?.score !== "number" ||
    typeof body.recommendation?.action !== "string"
  ) {
    throw new DemoError("DEMO_FAILED", "real-file response did not match the expected adapter-real-file shape.");
  }
  return {
    riskScore: body.risk.score,
    action: body.recommendation.action,
  };
}

async function runBuyerDryRun(root: string, runtimeCwd: string): Promise<void> {
  const result = await runCommand(
    "buyer dry-run",
    runtimeCwd,
    [
      "--prefix",
      join(root, "buyer-client"),
      "exec",
      "--",
      "tsx",
      join(root, "buyer-client", "src", "call-paid-report.ts"),
      "--dry-run",
    ],
    safeChildEnv(root),
  );
  const output = `${result.stdout}\n${result.stderr}`;
  for (const marker of [
    "received HTTP 402",
    `network:         ${EXPECTED_NETWORK}`,
    `amount (atomic): ${EXPECTED_AMOUNT_ATOMIC}`,
    "dry-run OK. No payment attempted.",
  ]) {
    if (!output.includes(marker)) {
      throw new DemoError("DEMO_FAILED", `buyer dry-run output missing expected marker: ${marker}`);
    }
  }
  if (output.includes("signing one")) {
    throw new DemoError("DEMO_FAILED", "buyer dry-run output indicates signing.");
  }
}

function withTemporaryEnv<T>(updates: NodeJS.ProcessEnv, run: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(updates)) previous.set(key, process.env[key]);
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return run();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function validateMissingSnapshotFallback(): void {
  const report = withTemporaryEnv(
    {
      DEFI_GUARDIAN_ADAPTER_MODE: "real-file",
      DEFI_GUARDIAN_SNAPSHOT_PATH: "D:\\nonexistent\\snapshot.json",
    },
    () => defiGuardianAdapter.analyzePosition(demoRequest()),
  );
  if (
    report.mode !== "adapter-mock" ||
    report.adapter.requestedMode !== "adapter-real-file" ||
    report.adapter.resolvedMode !== "adapter-mock" ||
    report.adapter.fallbackUsed !== true ||
    !report.warnings.some((warning) => warning.includes("Falling back to adapter-mock"))
  ) {
    throw new DemoError("DEMO_FAILED", "missing snapshot fallback did not resolve honestly to adapter-mock.");
  }
}

function printSummary(result: ResultKind, state: DemoState, error?: unknown): void {
  console.log("");
  console.log(`RESULT: ${result}`);
  if (result === "REAL_FILE_DEMO_SUCCEEDED") {
    console.log("Agentic Payments Lab real-file demo completed");
  } else if (error instanceof Error) {
    console.log(`Demo error: ${error.message}`);
  }
  console.log("");
  console.log(`Fallback honesty: ${state.fallback}`);
  console.log(`Health: ${state.health}`);
  console.log(`Real-file report: ${state.realFileReport}`);
  console.log(`Buyer dry-run: ${state.dryRun}`);
  console.log(`Dashboard render: ${state.render}`);
  console.log(`Seller stopped: ${state.sellerStopped ? "Yes" : "No"}`);
  console.log("x402 payment attempted: No");
  console.log("Mainnet used: No");
  console.log("USDT used: No");
  console.log("Secrets touched: No");
}

async function main(): Promise<number> {
  const root = projectRoot();
  const runtimeCwd = mkdtempSync(join(tmpdir(), "agentic-payments-lab-real-file-"));
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const state: DemoState = {
    fallback: "SKIPPED",
    health: "SKIPPED",
    realFileReport: "SKIPPED",
    dryRun: "SKIPPED",
    render: "SKIPPED",
    sellerStopped: false,
  };
  let seller: ChildProcessWithoutNullStreams | null = null;
  let result: ResultKind = "REAL_FILE_DEMO_SUCCEEDED";
  let failure: unknown;

  try {
    validateMissingSnapshotFallback();
    state.fallback = "OK";

    if (!(await isPortAvailable(PORT))) {
      throw new DemoError("BLOCKED", `port ${PORT} is already in use before the demo starts.`);
    }

    seller = startSeller(root, runtimeCwd, fixturePath(root));
    await waitForHealth(seller);
    state.health = "OK";

    const report = await postRealFileReport(timestamp);
    state.realFileReport = "OK";
    console.log(`Real-file report OK: riskScore=${report.riskScore} recommendation=${report.action}`);

    await runBuyerDryRun(root, runtimeCwd);
    state.dryRun = "OK";

    await runCommand("dashboard render", root, ["run", "dashboard:render"], safeChildEnv(root));
    state.render = "OK";
  } catch (error) {
    failure = error;
    result = error instanceof DemoError ? error.result : "DEMO_FAILED";
    if (state.fallback === "SKIPPED") state.fallback = "FAILED";
    else if (state.health === "SKIPPED") state.health = "FAILED";
    else if (state.realFileReport === "SKIPPED") state.realFileReport = "FAILED";
    else if (state.dryRun === "SKIPPED") state.dryRun = "FAILED";
    else if (state.render === "SKIPPED") state.render = "FAILED";
  } finally {
    await delay(500);
    state.sellerStopped = await stopSeller(seller);
  }

  printSummary(result, state, failure);
  return result === "REAL_FILE_DEMO_SUCCEEDED" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
