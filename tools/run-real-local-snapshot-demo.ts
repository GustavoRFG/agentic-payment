import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { PAYMENT_AMOUNT_USD, TESTNET_NETWORK, sanitizeEnv } from "../seller-api/src/config/safety.ts";
import { parseDefiGuardianSnapshotV1Json } from "../seller-api/src/adapters/defi-guardian/defiGuardianSnapshotV1.ts";
import type { RiskReportRequest } from "../seller-api/src/adapters/defi-guardian/reportTypes.ts";
import { projectRootFrom, runCommand } from "./_lib/child-process.ts";
import { type SellerHarness, startSeller } from "./_lib/seller-harness.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type ResultKind = "REAL_LOCAL_FILE_DEMO_SUCCEEDED" | "BLOCKED" | "DEMO_FAILED";

class DemoError extends Error {
  constructor(readonly result: ResultKind, message: string) {
    super(message);
  }
}

interface SelectedPosition {
  tokenId: string;
  alias: string;
  total: number;
}

function snapshotPath(root: string): string {
  return resolve(root, "runtime", "defi-guardian-snapshots", "latest.json");
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
  if (!first) throw new DemoError("BLOCKED", "local snapshot has no positions to demo.");
  return {
    tokenId: first.tokenId,
    alias: typeof first.walletAlias === "string" ? first.walletAlias : "(no alias)",
    total: result.snapshot.positions.length,
  };
}

function demoRequest(tokenId: string): RiskReportRequest {
  return { wallet: ZERO_ADDRESS, position: { protocol: "pancakeswap-v3", chain: "bsc", tokenId } };
}

async function postRealFileReport(
  seller: SellerHarness,
  tokenId: string,
  timestamp: string,
): Promise<{ riskScore: number; action: string }> {
  const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
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

function printSummary(
  result: ResultKind,
  selected: SelectedPosition | null,
  report: { riskScore: number; action: string } | null,
  sellerStopped: boolean,
  error?: unknown,
): void {
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
  const root = projectRootFrom(import.meta.url);
  const file = snapshotPath(root);
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  let seller: SellerHarness | null = null;
  let result: ResultKind = "REAL_LOCAL_FILE_DEMO_SUCCEEDED";
  let selected: SelectedPosition | null = null;
  let report: { riskScore: number; action: string } | null = null;
  let failure: unknown;
  let sellerStopped = false;

  try {
    selected = loadAndValidateSnapshot(file);
    seller = await startSeller({ projectRoot: root, adapterMode: "real-file", snapshotPath: file });
    report = await postRealFileReport(seller, selected.tokenId, timestamp);
    await runCommand("dashboard render", root, ["run", "dashboard:render"], childEnv(root, seller));
  } catch (error) {
    failure = error;
    result = error instanceof DemoError ? error.result : "DEMO_FAILED";
  } finally {
    if (seller) await seller.stop();
    sellerStopped = true;
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
