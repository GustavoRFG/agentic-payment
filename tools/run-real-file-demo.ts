import { join } from "node:path";

import {
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  TESTNET_NETWORK,
  sanitizeEnv,
} from "../seller-api/src/config/safety.ts";
import { defiGuardianAdapter } from "../seller-api/src/adapters/defi-guardian/defiGuardianAdapter.ts";
import type { RiskReportRequest } from "../seller-api/src/adapters/defi-guardian/reportTypes.ts";
import { projectRootFrom, runCommand } from "./_lib/child-process.ts";
import { type SellerHarness, startSeller } from "./_lib/seller-harness.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

class DemoError extends Error {
  constructor(
    readonly result: ResultKind,
    message: string,
  ) {
    super(message);
  }
}

function fixturePath(root: string): string {
  return join(
    root,
    "seller-api",
    "src",
    "adapters",
    "defi-guardian",
    "defiGuardianSnapshotV1.sample.json",
  );
}

function childEnv(root: string, seller: SellerHarness): NodeJS.ProcessEnv {
  return {
    ...sanitizeEnv(),
    AGENTIC_SKIP_DOTENV: "1",
    SELLER_BASE_URL: seller.baseUrl,
    X402_NETWORK: TESTNET_NETWORK,
    MAX_PAYMENT_USD: PAYMENT_AMOUNT_USD,
    AGENTIC_AUDIT_LOG_DIR: join(root, "logs"),
  };
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

async function postRealFileReport(
  seller: SellerHarness,
  timestamp: string,
): Promise<{ riskScore: number; action: string }> {
  const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
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

async function runBuyerDryRun(root: string, seller: SellerHarness): Promise<void> {
  const result = await runCommand(
    "buyer dry-run",
    root,
    [
      "--prefix",
      join(root, "buyer-client"),
      "exec",
      "--",
      "tsx",
      join(root, "buyer-client", "src", "call-paid-report.ts"),
      "--dry-run",
    ],
    childEnv(root, seller),
  );
  const output = `${result.stdout}\n${result.stderr}`;
  for (const marker of [
    "received HTTP 402",
    `network:         ${TESTNET_NETWORK}`,
    `amount (atomic): ${PAYMENT_AMOUNT_ATOMIC}`,
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
  const root = projectRootFrom(import.meta.url);
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const state: DemoState = {
    fallback: "SKIPPED",
    health: "SKIPPED",
    realFileReport: "SKIPPED",
    dryRun: "SKIPPED",
    render: "SKIPPED",
    sellerStopped: false,
  };
  let seller: SellerHarness | null = null;
  let result: ResultKind = "REAL_FILE_DEMO_SUCCEEDED";
  let failure: unknown;

  try {
    validateMissingSnapshotFallback();
    state.fallback = "OK";

    seller = await startSeller({
      projectRoot: root,
      adapterMode: "real-file",
      snapshotPath: fixturePath(root),
    });
    state.health = "OK";

    const report = await postRealFileReport(seller, timestamp);
    state.realFileReport = "OK";
    console.log(`Real-file report OK: riskScore=${report.riskScore} recommendation=${report.action}`);

    await runBuyerDryRun(root, seller);
    state.dryRun = "OK";

    await runCommand("dashboard render", root, ["run", "dashboard:render"], childEnv(root, seller));
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
    if (seller) {
      await seller.stop();
      state.sellerStopped = true;
    } else {
      state.sellerStopped = true;
    }
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
