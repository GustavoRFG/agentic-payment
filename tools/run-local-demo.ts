import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";

const PORT = 4021;
const BASE_URL = `http://localhost:${PORT}`;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EXPECTED_NETWORK = "eip155:84532";
const EXPECTED_ASSET = "USDC";
const EXPECTED_AMOUNT_ATOMIC = "1000";
const EXPECTED_AMOUNT_USD = "0.001";

type ResultKind = "LOCAL_DEMO_SUCCEEDED" | "BLOCKED" | "DEMO_FAILED";

interface DemoFlags {
  skipOpen: boolean;
  noExport: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface DemoState {
  health: "OK" | "FAILED" | "SKIPPED";
  mock: "OK" | "FAILED" | "SKIPPED";
  dryRun: "OK" | "FAILED" | "SKIPPED";
  render: "OK" | "FAILED" | "SKIPPED";
  export: "OK" | "FAILED" | "SKIPPED";
  listExports: "OK" | "FAILED" | "SKIPPED";
  exportPath: string | null;
  sellerStopped: boolean;
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

function parseArgs(argv: string[]): DemoFlags {
  return {
    skipOpen: argv.includes("--skip-open"),
    noExport: argv.includes("--no-export"),
  };
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
    if (!key || key.startsWith("=") || typeof value !== "string") {
      continue;
    }
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

function startSeller(root: string, runtimeCwd: string): ChildProcessWithoutNullStreams {
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
    env: safeChildEnv(root),
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
  seller.once("exit", (code) => {
    if (code !== null && code !== 0) {
      output += `\n[seller exited with code ${code}]`;
    }
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
  if (!seller || seller.exitCode !== null) {
    return true;
  }
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
      if (response.status === 200) {
        return;
      }
    } catch {
      // Server may still be starting.
    }
    await delay(500);
  }
  throw new DemoError("BLOCKED", `seller health check timed out.\n${tail(sellerOutput(seller))}`);
}

async function postMockReport(timestamp: string): Promise<{ reportId: string; riskScore: number }> {
  const response = await fetch(`${BASE_URL}/mock/defi-risk-report`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Agentic-Request-Id": `demo-mock-${timestamp}`,
    },
    body: JSON.stringify({
      wallet: ZERO_ADDRESS,
      position: {
        protocol: "pancakeswap",
        chain: "bsc",
        tokenId: "demo-position-001",
        pair: "CAKE/BNB",
        rangeStatus: "near_edge",
        liquidityUsd: 420,
        feesUsd: 3.42,
        impermanentLossEstimatePct: 3.4,
        healthFlags: ["manual-review"],
      },
    }),
  });

  const body = (await response.json()) as {
    reportId?: unknown;
    mode?: unknown;
    risk?: { score?: unknown };
  };
  if (response.status !== 200) {
    throw new DemoError("DEMO_FAILED", `mock endpoint returned HTTP ${response.status}.`);
  }
  if (body.mode !== "adapter-mock" || typeof body.reportId !== "string" || typeof body.risk?.score !== "number") {
    throw new DemoError("DEMO_FAILED", "mock endpoint response did not include the expected adapter-mock report shape.");
  }
  return { reportId: body.reportId, riskScore: body.risk.score };
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
  const expected = [
    "received HTTP 402",
    `network:         ${EXPECTED_NETWORK}`,
    `amount (atomic): ${EXPECTED_AMOUNT_ATOMIC}`,
    EXPECTED_ASSET,
    "dry-run OK. No payment attempted.",
  ];
  for (const marker of expected) {
    if (!output.includes(marker)) {
      throw new DemoError("DEMO_FAILED", `buyer dry-run output missing expected marker: ${marker}`);
    }
  }
  if (output.includes("signing one")) {
    throw new DemoError("DEMO_FAILED", "buyer dry-run output indicates signing; refusing demo result.");
  }
}

function parseExportPath(output: string): string | null {
  const match = output.match(/^- output:\s*(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function printSummary(result: ResultKind, state: DemoState, error?: unknown): void {
  console.log("");
  console.log(`RESULT: ${result}`);
  if (result === "LOCAL_DEMO_SUCCEEDED") {
    console.log("Agentic Payments Lab local demo completed");
  } else if (error instanceof Error) {
    console.log(`Demo error: ${error.message}`);
  }
  console.log("");
  console.log(`Health: ${state.health}`);
  console.log(`Mock report: ${state.mock}`);
  console.log(`Buyer dry-run: ${state.dryRun}`);
  console.log(`Dashboard render: ${state.render}`);
  console.log(`Dashboard export: ${state.export}`);
  console.log(`Dashboard list exports: ${state.listExports}`);
  console.log(`Export path: ${state.exportPath ?? "n/a"}`);
  console.log(`Seller stopped: ${state.sellerStopped ? "Yes" : "No"}`);
  console.log("x402 payment attempted: No");
  console.log("Mainnet used: No");
  console.log("USDT used: No");
  console.log("Secrets touched: No");
}

async function main(): Promise<number> {
  const flags = parseArgs(process.argv.slice(2));
  const root = projectRoot();
  const runtimeCwd = mkdtempSync(join(tmpdir(), "agentic-payments-lab-demo-"));
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const state: DemoState = {
    health: "SKIPPED",
    mock: "SKIPPED",
    dryRun: "SKIPPED",
    render: "SKIPPED",
    export: flags.noExport ? "SKIPPED" : "SKIPPED",
    listExports: "SKIPPED",
    exportPath: null,
    sellerStopped: false,
  };
  let seller: ChildProcessWithoutNullStreams | null = null;
  let result: ResultKind = "LOCAL_DEMO_SUCCEEDED";
  let failure: unknown;

  try {
    if (!(await isPortAvailable(PORT))) {
      throw new DemoError("BLOCKED", `port ${PORT} is already in use before the demo starts.`);
    }

    seller = startSeller(root, runtimeCwd);
    await waitForHealth(seller);
    state.health = "OK";

    const mock = await postMockReport(timestamp);
    state.mock = "OK";
    console.log(`Mock report OK: reportId=${mock.reportId} riskScore=${mock.riskScore}`);

    await runBuyerDryRun(root, runtimeCwd);
    state.dryRun = "OK";

    await runCommand("dashboard render", root, ["run", "dashboard:render"], safeChildEnv(root));
    state.render = "OK";

    if (!flags.noExport) {
      const exportResult = await runCommand("dashboard export", root, ["run", "dashboard:export"], safeChildEnv(root));
      state.exportPath = parseExportPath(exportResult.stdout);
      state.export = "OK";
    }

    await runCommand("dashboard list exports", root, ["run", "dashboard:list-exports"], safeChildEnv(root));
    state.listExports = "OK";

    if (!flags.skipOpen) {
      // The MVP 001H default intentionally does not open a browser. The flag is
      // accepted for compatibility with future wrappers.
    }
  } catch (error) {
    failure = error;
    result = error instanceof DemoError ? error.result : "DEMO_FAILED";
    if (state.health === "SKIPPED") state.health = "FAILED";
    else if (state.mock === "SKIPPED") state.mock = "FAILED";
    else if (state.dryRun === "SKIPPED") state.dryRun = "FAILED";
    else if (state.render === "SKIPPED") state.render = "FAILED";
    else if (state.export === "SKIPPED" && !flags.noExport) state.export = "FAILED";
    else if (state.listExports === "SKIPPED") state.listExports = "FAILED";
  } finally {
    await delay(500);
    state.sellerStopped = await stopSeller(seller);
  }

  printSummary(result, state, failure);
  return result === "LOCAL_DEMO_SUCCEEDED" ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
