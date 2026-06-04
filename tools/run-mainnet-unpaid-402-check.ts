import dotenv from "dotenv";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAddress } from "../seller-api/node_modules/viem/_esm/index.js";

import {
  MAINNET_FACILITATOR_URL,
  MAINNET_NETWORK,
  MAINNET_USDC_ADDRESS,
  PAYMENT_AMOUNT_ATOMIC,
} from "../seller-api/src/config/safety.ts";
import { npmCommand, projectRootFrom, tail } from "./_lib/child-process.ts";

interface AcceptEntry {
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  extra?: Record<string, unknown>;
}

interface PaymentRequiredEnvelope {
  accepts?: AcceptEntry[];
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function loadLocalEnv(root: string): void {
  const sellerEnv = join(root, "seller-api", ".env");
  if (existsSync(sellerEnv)) dotenv.config({ path: sellerEnv, override: false });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function spawnNpm(args: string[], options: Parameters<typeof spawn>[2]): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", npmCommand(), ...args], options);
  }
  return spawn(npmCommand(), args, options);
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
        else rejectPort(new Error("unable to allocate local port"));
      });
    });
  });
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

async function waitForHealth(baseUrl: string, child: ChildProcessWithoutNullStreams, output: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`seller failed to start.\n${tail(output())}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.status === 200) return;
    } catch {
      // Seller is still starting.
    }
    await delay(500);
  }
  throw new Error(`seller health check timed out.\n${tail(output())}`);
}

async function startMainnetSeller(root: string): Promise<{
  baseUrl: string;
  output: () => string;
  stop: () => Promise<void>;
}> {
  const port = await allocatePort();
  const baseUrl = `http://localhost:${port}`;
  let outputText = "";
  const child = spawnNpm(["run", "dev"], {
    cwd: join(root, "seller-api"),
    env: {
      ...process.env,
      AGENTIC_SKIP_DOTENV: "1",
      AGENTIC_ADAPTER_MOCK: "1",
      AGENTIC_AUDIT_LOG_DIR: mkdtempSync(join(tmpdir(), "agentic-payments-mainnet-402-")),
      PORT: String(port),
      SELLER_BASE_URL: baseUrl,
      X402_USE_MAINNET: "1",
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => (outputText += chunk.toString()));
  child.stderr.on("data", (chunk) => (outputText += chunk.toString()));
  child.on("error", (error) => {
    outputText += `\n${error.message}`;
  });
  const output = () => outputText;
  await waitForHealth(baseUrl, child, output);
  return {
    baseUrl,
    output,
    stop: async () => stopProcess(child),
  };
}

function paymentAssetAddress(entry: AcceptEntry): string | undefined {
  const candidates = [
    entry.asset,
    entry.extra?.asset,
    entry.extra?.assetAddress,
    entry.extra?.tokenAddress,
    entry.extra?.contractAddress,
  ];
  return candidates.find((value): value is string => {
    return typeof value === "string" && value.startsWith("0x");
  });
}

function decodePaymentRequired(raw: string): PaymentRequiredEnvelope {
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8")) as PaymentRequiredEnvelope;
}

function assertLocalMainnetEnv(): void {
  const receiver = process.env.SELLER_RECEIVER_ADDRESS?.trim() ?? "";
  const missing: string[] = [];
  if (process.env.X402_USE_MAINNET !== "1") missing.push("X402_USE_MAINNET");
  if (!receiver || !isAddress(receiver) || receiver.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    missing.push("SELLER_RECEIVER_ADDRESS");
  }
  if (!process.env.CDP_API_KEY_ID?.trim()) missing.push("CDP_API_KEY_ID");
  if (!process.env.CDP_API_KEY_SECRET?.trim()) missing.push("CDP_API_KEY_SECRET");
  if (missing.length > 0) {
    throw new Error(`missing or invalid local mainnet env: ${[...new Set(missing)].join(", ")}`);
  }
}

async function main(): Promise<void> {
  const root = projectRootFrom(import.meta.url);
  loadLocalEnv(root);
  assertLocalMainnetEnv();

  let seller: Awaited<ReturnType<typeof startMainnetSeller>> | null = null;
  try {
    seller = await startMainnetSeller(root);
    const response = await fetch(`${seller.baseUrl}/paid/analyze-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agentic-Request-Id": "mainnet-unpaid-402-check",
      },
      body: JSON.stringify({ text: "Mainnet unpaid 402 check.", mode: "summary" }),
    });
    if (response.status !== 402) {
      throw new Error(`HTTP ${response.status}, expected 402. Seller output:\n${tail(seller.output())}`);
    }
    const raw = response.headers.get("payment-required") ?? "";
    if (!raw) throw new Error("missing PAYMENT-REQUIRED header");

    const accept = decodePaymentRequired(raw).accepts?.[0];
    if (!accept) throw new Error("missing accepts entry");
    const amount = accept.amount ?? accept.maxAmountRequired ?? "";
    const asset = paymentAssetAddress(accept);

    if (accept.network !== MAINNET_NETWORK) {
      throw new Error(`network=${accept.network}, expected ${MAINNET_NETWORK}`);
    }
    if (asset?.toLowerCase() !== MAINNET_USDC_ADDRESS.toLowerCase()) {
      throw new Error(`asset=${asset ?? "(missing)"}, expected ${MAINNET_USDC_ADDRESS}`);
    }
    if (amount !== PAYMENT_AMOUNT_ATOMIC) {
      throw new Error(`amountAtomic=${amount}, expected ${PAYMENT_AMOUNT_ATOMIC}`);
    }
    if (!seller.output().includes(MAINNET_FACILITATOR_URL)) {
      throw new Error("seller log did not show the production CDP facilitator URL");
    }

    console.log(`HTTP: ${response.status}`);
    console.log(`network: ${accept.network}`);
    console.log(`asset: ${asset}`);
    console.log(`amountAtomic: ${amount}`);
    console.log(`facilitator: ${MAINNET_FACILITATOR_URL}`);
    console.log("payment attempted: No");
    console.log("RESULT: MAINNET_UNPAID_402_CHECK_PASSED");
  } finally {
    await seller?.stop();
  }
}

main().catch((error) => {
  console.error("[mainnet:dry-run] error:", (error as Error).message);
  process.exitCode = 1;
});
