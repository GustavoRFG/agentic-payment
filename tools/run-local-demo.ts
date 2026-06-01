import { join } from "node:path";

import {
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  TESTNET_NETWORK,
  sanitizeEnv,
} from "../seller-api/src/config/safety.ts";
import { projectRootFrom, runCommand } from "./_lib/child-process.ts";
import { type SellerHarness, startSeller } from "./_lib/seller-harness.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type ResultKind = "LOCAL_DEMO_SUCCEEDED" | "BLOCKED" | "DEMO_FAILED";
type StepState = "OK" | "FAILED" | "SKIPPED";

interface DemoFlags {
  skipOpen: boolean;
  noExport: boolean;
}

interface DemoState {
  health: StepState;
  mock: StepState;
  dryRun: StepState;
  render: StepState;
  export: StepState;
  listExports: StepState;
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

function parseArgs(argv: string[]): DemoFlags {
  return {
    skipOpen: argv.includes("--skip-open"),
    noExport: argv.includes("--no-export"),
  };
}

function childEnv(root: string, seller: SellerHarness, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...sanitizeEnv(),
    AGENTIC_SKIP_DOTENV: "1",
    SELLER_BASE_URL: seller.baseUrl,
    X402_NETWORK: TESTNET_NETWORK,
    MAX_PAYMENT_USD: PAYMENT_AMOUNT_USD,
    AGENTIC_AUDIT_LOG_DIR: join(root, "logs"),
    ...extra,
  };
}

async function postMockReport(
  seller: SellerHarness,
  timestamp: string,
): Promise<{ reportId: string; riskScore: number }> {
  const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
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
  if (
    body.mode !== "adapter-mock" ||
    typeof body.reportId !== "string" ||
    typeof body.risk?.score !== "number"
  ) {
    throw new DemoError("DEMO_FAILED", "mock endpoint response did not include the expected adapter-mock report shape.");
  }
  return { reportId: body.reportId, riskScore: body.risk.score };
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
  const expected = [
    "received HTTP 402",
    `network:         ${TESTNET_NETWORK}`,
    `amount (atomic): ${PAYMENT_AMOUNT_ATOMIC}`,
    PAYMENT_ASSET,
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
  const root = projectRootFrom(import.meta.url);
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
  let seller: SellerHarness | null = null;
  let result: ResultKind = "LOCAL_DEMO_SUCCEEDED";
  let failure: unknown;

  try {
    seller = await startSeller({ projectRoot: root, adapterMode: "mock" });
    state.health = "OK";

    const mock = await postMockReport(seller, timestamp);
    state.mock = "OK";
    console.log(`Mock report OK: reportId=${mock.reportId} riskScore=${mock.riskScore}`);

    await runBuyerDryRun(root, seller);
    state.dryRun = "OK";

    await runCommand("dashboard render", root, ["run", "dashboard:render"], childEnv(root, seller));
    state.render = "OK";

    if (!flags.noExport) {
      const exportResult = await runCommand("dashboard export", root, ["run", "dashboard:export"], childEnv(root, seller));
      state.exportPath = parseExportPath(exportResult.stdout);
      state.export = "OK";
    }

    await runCommand("dashboard list exports", root, ["run", "dashboard:list-exports"], childEnv(root, seller));
    state.listExports = "OK";

    if (!flags.skipOpen) {
      // The MVP 001H default intentionally does not open a browser.
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
    if (seller) {
      await seller.stop();
      state.sellerStopped = true;
    } else {
      state.sellerStopped = true;
    }
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
