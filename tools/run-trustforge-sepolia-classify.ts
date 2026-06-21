/**
 * run-trustforge-sepolia-classify — read-only Sepolia reconcile + PASS_SETTLED classification.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import {
  buildSepoliaReconcileArgs,
  classifySepoliaSettlement,
  parseReconciliationLedger,
} from "./trustforge/sepolia-settlement-classify";
import { assertMainnetBuyerKeyAbsent } from "./trustforge/sepolia-settlement-guards";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

async function main(): Promise<number> {
  assertMainnetBuyerKeyAbsent();
  const runArg = process.argv.indexOf("--run-dir");
  if (runArg < 0) {
    console.error("Usage: tsx tools/run-trustforge-sepolia-classify.ts --run-dir <path>");
    return 1;
  }
  const runDir = process.argv[runArg + 1];
  const selected = JSON.parse(
    await readFile(join(runDir, "selected_candidate.json"), "utf8"),
  ) as DiscoveredSelectedCandidate;
  const executionPath = join(runDir, "settlement_probe", "01_execution.json");
  if (!existsSync(executionPath)) {
    console.error("BLOCKED_NO_SETTLEMENT_EXECUTION: run human settlement probe first");
    return 1;
  }
  const execution = JSON.parse(await readFile(executionPath, "utf8")) as {
    paymentAttempted: boolean;
    paymentBearingHttpRequestCount: number;
    httpStatus: number | null;
    balanceBeforeUsdc?: string;
  };

  const reconcileDir = join(runDir, "sepolia_reconciliation");
  await mkdir(reconcileDir, { recursive: true });
  const args = [
    "tools/run-onchain-settlement-reconciliation.py",
    ...buildSepoliaReconcileArgs(selected, execution.balanceBeforeUsdc),
    "--output-dir",
    reconcileDir,
  ];
  execSync(`python ${args.map((a) => `"${a}"`).join(" ")}`, {
    cwd: REPO,
    stdio: "inherit",
    env: { ...process.env, BUYER_PRIVATE_KEY: "" },
  });

  const ledger = JSON.parse(
    await readFile(join(reconcileDir, "onchain_settlement_ledger.json"), "utf8"),
  ) as Record<string, unknown>;
  const parsed = parseReconciliationLedger(ledger);
  const classification = classifySepoliaSettlement({
    probe: {
      paymentAttempted: execution.paymentAttempted,
      paymentBearingHttpRequestCount: execution.paymentBearingHttpRequestCount,
      httpStatus: execution.httpStatus,
      balanceBeforeUsdc: execution.balanceBeforeUsdc,
      onChainConfirmed: parsed.safeToUseForPaymentVerification && Boolean(parsed.settlementTxHash),
      settlementTxHash: parsed.settlementTxHash,
    },
    reconciliationUnavailable: parsed.rpcUnavailable,
    reconciliationStatus: parsed.reconciliationStatus,
    safeToUseForPaymentVerification: parsed.safeToUseForPaymentVerification,
    unattributedSettlementsFound: parsed.unattributedSettlementsFound,
    balanceIdentityStatus: parsed.balanceIdentityStatus,
    settlementTxHash: parsed.settlementTxHash,
  });

  await writeFile(
    join(runDir, "sepolia_classification.json"),
    `${JSON.stringify(classification, null, 2)}\n`,
    "utf8",
  );

  const proven = classification.outcome === "PASS_SETTLED";
  const lines = [
    "RESULT",
    proven ? "SEPOLIA_SETTLEMENT_PROVEN" : `sepolia_classification_status: ${classification.outcome}`,
    `run_dir: ${runDir}`,
    `paid_probe_outcome: ${classification.outcome}`,
    `settlement_tx_hash: ${classification.settlementTxHash ?? "null"}`,
    `reconciliation_status: ${classification.reconciliationStatus ?? "null"}`,
    `unattributed_settlements_found: ${classification.unattributedSettlementsFound ?? "null"}`,
    `balance_identity_status: ${classification.balanceIdentityStatus ?? "null"}`,
    `safe_to_use_for_payment_verification: ${classification.safeToUseForPaymentVerification ? "yes" : "no"}`,
    "agent_signed: no",
    "strict_no_mainnet: yes",
    `detail: ${classification.detail}`,
    "NEXT",
    proven
      ? "Mainnet path unblocked pending human authorization."
      : classification.outcome === "PASS_NO_SETTLE_CLEAN"
        ? "Happy path not proven — do not retry without new authorization."
        : "Resolve blocker; do not retry-grind.",
  ];
  await writeFile(join(runDir, "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  return proven ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
