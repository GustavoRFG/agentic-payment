import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PAYMENT_AMOUNT_USD,
  PAYMENT_PRICE_LABEL,
  TESTNET_NETWORK,
  isMainnetNetwork,
  sanitizeEnv,
} from "../../seller-api/src/config/safety.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface SellerHarnessOptions {
  projectRoot: string;
  port?: number;
  adapterMode?: "mock" | "real-file";
  snapshotPath?: string;
  auditLogDir?: string;
}

export interface SellerHarness {
  baseUrl: string;
  port: number;
  output: () => string;
  stop: () => Promise<void>;
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

async function allocatePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", (error) => rejectPort(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() => {
        if (typeof port === "number") resolvePort(port);
        else rejectPort(new Error("unable to allocate a local port"));
      });
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", () => rejectPort(new Error(`port ${port} is already in use`)));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort()));
  });
}

function tail(text: string, max = 2400): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

async function waitForHealth(baseUrl: string, seller: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (seller.exitCode !== null) {
      throw new Error(`seller failed to start.\n${tail(output())}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {
      // Server may still be starting.
    }
    await delay(500);
  }
  throw new Error(`seller health check timed out.\n${tail(output())}`);
}

async function stopProcess(child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolveKill) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("close", () => resolveKill());
      killer.on("error", () => resolveKill());
    });
  } else {
    child.kill("SIGTERM");
  }
  await delay(500);
}

function sellerEnv(options: Required<Pick<SellerHarnessOptions, "projectRoot">> & SellerHarnessOptions, port: number): NodeJS.ProcessEnv {
  if (isMainnetNetwork(process.env.X402_NETWORK)) {
    throw new Error(`refusing to start seller with inherited mainnet X402_NETWORK=${process.env.X402_NETWORK}`);
  }
  const adapterMode = options.adapterMode ?? "mock";
  const env = sanitizeEnv();
  delete env.X402_USE_MAINNET;
  delete env.X402_NETWORK;
  return {
    ...env,
    AGENTIC_SKIP_DOTENV: "1",
    PORT: String(port),
    SELLER_BASE_URL: `http://localhost:${port}`,
    SELLER_RECEIVER_ADDRESS: ZERO_ADDRESS,
    REPORT_PRICE_USD: PAYMENT_PRICE_LABEL,
    X402_NETWORK: TESTNET_NETWORK,
    MAX_PAYMENT_USD: PAYMENT_AMOUNT_USD,
    AGENTIC_ADAPTER_MOCK: "1",
    AGENTIC_AUDIT_LOG_DIR:
      options.auditLogDir ?? mkdtempSync(join(tmpdir(), "agentic-payments-lab-seller-logs-")),
    DEFI_GUARDIAN_ADAPTER_MODE: adapterMode,
    ...(adapterMode === "real-file" && options.snapshotPath
      ? { DEFI_GUARDIAN_SNAPSHOT_PATH: options.snapshotPath }
      : {}),
  };
}

export async function startSeller(options: SellerHarnessOptions): Promise<SellerHarness> {
  const port = options.port ?? (await allocatePort());
  await assertPortAvailable(port);

  const baseUrl = `http://localhost:${port}`;
  const sellerDir = join(options.projectRoot, "seller-api");
  let outputText = "";
  const seller = spawnNpm(["run", "dev"], {
    cwd: sellerDir,
    env: sellerEnv(options, port),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  seller.stdout.on("data", (chunk) => (outputText += chunk.toString()));
  seller.stderr.on("data", (chunk) => (outputText += chunk.toString()));
  seller.on("error", (error) => {
    outputText += `\n${error.message}`;
  });

  const harness: SellerHarness = {
    baseUrl,
    port,
    output: () => outputText,
    stop: async () => {
      await stopProcess(seller);
    },
  };

  try {
    await waitForHealth(baseUrl, seller, harness.output);
  } catch (error) {
    await harness.stop();
    throw error;
  }

  return harness;
}
