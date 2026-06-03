/**
 * MVP 002D.0 - Optional paid-report real-local source, dry-run only.
 *
 * This script never executes a payment. It validates an existing local
 * sanitized snapshot, serves it through the paid endpoint, confirms unpaid
 * HTTP 402, and runs the buyer in --dry-run mode.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  TESTNET_NETWORK,
  sanitizeEnv,
} from "../seller-api/src/config/safety.ts";
import { parseDefiGuardianSnapshotV1Json } from "../seller-api/src/adapters/defi-guardian/defiGuardianSnapshotV1.ts";
import type { RiskReportRequest } from "../seller-api/src/adapters/defi-guardian/reportTypes.ts";
import { projectRootFrom, runCommand } from "./_lib/child-process.ts";
import { type SellerHarness, startSeller } from "./_lib/seller-harness.ts";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

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

interface SelectedPosition {
  tokenId: string;
  alias: string;
  inRange: boolean;
  total: number;
}

interface AcceptEntry {
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  extra?: { name?: string };
}

class DemoError extends Error {
  constructor(readonly result: ResultKind, message: string) {
    super(message);
  }
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
  if (!chosen) throw new DemoError("BLOCKED", "local snapshot has no positions to demo.");
  return {
    tokenId: chosen.tokenId,
    alias: typeof chosen.walletAlias === "string" ? chosen.walletAlias : "(no alias)",
    inRange: chosen.inRange,
    total: result.snapshot.positions.length,
  };
}

function demoRequest(tokenId: string): RiskReportRequest {
  return { wallet: ZERO_ADDRESS, position: { protocol: "pancakeswap-v3", chain: "bsc", tokenId } };
}

async function postPublicRealFileReport(
  seller: SellerHarness,
  tokenId: string,
  timestamp: string,
): Promise<{ riskScore: number; action: string }> {
  const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
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

async function postProtectedUnpaid(
  seller: SellerHarness,
  tokenId: string,
  timestamp: string,
): Promise<void> {
  const response = await fetch(`${seller.baseUrl}/paid/defi-risk-report`, {
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
  const asset = accept.extra?.name ?? PAYMENT_ASSET;
  const amountUsd = atomicUsdcToUsd(amountAtomic);
  if (accept.network !== TESTNET_NETWORK) {
    throw new DemoError("DEMO_FAILED", `402 network=${accept.network}, expected ${TESTNET_NETWORK}.`);
  }
  if (asset !== PAYMENT_ASSET) {
    throw new DemoError("DEMO_FAILED", `402 asset=${asset}, expected ${PAYMENT_ASSET}.`);
  }
  if (amountAtomic !== PAYMENT_AMOUNT_ATOMIC) {
    throw new DemoError("DEMO_FAILED", `402 amountAtomic=${amountAtomic}, expected ${PAYMENT_AMOUNT_ATOMIC}.`);
  }
  if (amountUsd !== PAYMENT_AMOUNT_USD) {
    throw new DemoError("DEMO_FAILED", `402 amountUsd=${amountUsd}, expected ${PAYMENT_AMOUNT_USD}.`);
  }
  console.log(
    `Protected endpoint unpaid: HTTP 402 network=${accept.network} asset=${asset} ` +
      `amountAtomic=${amountAtomic} amountUsd=${amountUsd}`,
  );
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
  const markers = [
    "received HTTP 402",
    `network:         ${TESTNET_NETWORK}`,
    `amount (atomic): ${PAYMENT_AMOUNT_ATOMIC}`,
    PAYMENT_ASSET,
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
  console.log(`Protected endpoint unpaid response: ${state.protectedUnpaid === "OK" ? "HTTP 402" : state.protectedUnpaid}`);
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
  const root = projectRootFrom(import.meta.url);
  const file = snapshotPath(root);
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
  let seller: SellerHarness | null = null;
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

    seller = await startSeller({ projectRoot: root, adapterMode: "real-file", snapshotPath: file });
    state.health = "OK";

    const report = await postPublicRealFileReport(seller, selected.tokenId, timestamp);
    state.publicRealFile = "OK";
    console.log(`Public real-file report OK: riskScore=${report.riskScore} recommendation=${report.action}`);

    await postProtectedUnpaid(seller, selected.tokenId, timestamp);
    state.protectedUnpaid = "OK";

    await runBuyerDryRun(root, seller);
    state.buyerDryRun = "OK";

    await runCommand("dashboard render", root, ["run", "dashboard:render"], childEnv(root, seller));
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
    if (seller) await seller.stop();
    state.sellerStopped = true;
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
