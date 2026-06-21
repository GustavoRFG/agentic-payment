/**
 * run-trustforge-sepolia-classify — read-only Sepolia reconcile + PASS_SETTLED classification.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";
import {
  buildSepoliaReconcileArgs,
  classifySepoliaSettlement,
  confirmSepoliaSettlementBinding,
  parseReconciliationLedger,
} from "./trustforge/sepolia-settlement-classify";
import { assertMainnetBuyerKeyAbsent } from "./trustforge/sepolia-settlement-guards";
import type { SettlementIntent } from "./trustforge/settlement-run-binding";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

async function findSettlementIntent(runDir: string): Promise<SettlementIntent | null> {
  if (!existsSync(runDir)) return null;
  const intentFile = readdirSync(runDir).find((name) => name.startsWith("settlement_intent_"));
  if (!intentFile) return null;
  return JSON.parse(await readFile(join(runDir, intentFile), "utf8")) as SettlementIntent;
}

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
    facilitatorTransactionHash?: string | null;
    intentPath?: string;
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

  let bindingResult: ReturnType<typeof confirmSepoliaSettlementBinding> | null = null;
  let intent: SettlementIntent | null = null;
  if (execution.intentPath && existsSync(execution.intentPath)) {
    intent = JSON.parse(await readFile(execution.intentPath, "utf8")) as SettlementIntent;
  } else {
    intent = await findSettlementIntent(runDir);
  }
  if (intent) {
    bindingResult = confirmSepoliaSettlementBinding({
      intent,
      ledger,
      facilitatorReportedHash: execution.facilitatorTransactionHash ?? null,
    });
    await writeFile(
      join(runDir, `settlement_binding_${intent.attempt_id}.json`),
      `${JSON.stringify(bindingResult.binding, null, 2)}\n`,
      "utf8",
    );
  }

  const settlementTxHash =
    bindingResult?.binding.settlement_tx_hash ??
    parsed.settlementTxHash ??
    execution.facilitatorTransactionHash ??
    null;
  const onChainConfirmed = Boolean(
    bindingResult?.binding.settlement_status === "confirmed" ||
      (parsed.safeToUseForPaymentVerification && Boolean(parsed.settlementTxHash)),
  );

  const classification = classifySepoliaSettlement({
    probe: {
      paymentAttempted: execution.paymentAttempted,
      paymentBearingHttpRequestCount: execution.paymentBearingHttpRequestCount,
      httpStatus: execution.httpStatus,
      balanceBeforeUsdc: execution.balanceBeforeUsdc,
      onChainConfirmed,
      settlementTxHash,
    },
    reconciliationUnavailable: parsed.rpcUnavailable,
    reconciliationStatus: parsed.reconciliationStatus,
    safeToUseForPaymentVerification: parsed.safeToUseForPaymentVerification,
    unattributedSettlementsFound: parsed.unattributedSettlementsFound,
    balanceIdentityStatus: parsed.balanceIdentityStatus,
    settlementTxHash,
    binding: bindingResult?.binding ?? null,
    bindingMetrics: bindingResult?.metrics ?? null,
  });

  await writeFile(
    join(runDir, "sepolia_classification.json"),
    `${JSON.stringify(classification, null, 2)}\n`,
    "utf8",
  );

  const proven = classification.outcome === "PASS_SETTLED";
  const metrics = bindingResult?.metrics;
  const lines = [
    "RESULT",
    proven ? "SEPOLIA_SETTLEMENT_PROVEN" : `sepolia_classification_status: ${classification.outcome}`,
    `run_dir: ${runDir}`,
    `paid_probe_outcome: ${classification.outcome}`,
    `settlement_tx_hash: ${classification.settlementTxHash ?? "null"}`,
    `reconciliation_status: ${classification.reconciliationStatus ?? "null"}`,
    `unattributed_settlements_found: ${metrics?.unattributed_settlements_found ?? classification.unattributedSettlementsFound ?? "null"}`,
    `total_outflow_settlements_found: ${metrics?.total_outflow_settlements_found ?? "null"}`,
    `known_settlements_confirmed_onchain: ${metrics?.known_settlements_confirmed_onchain ?? "null"}`,
    `phase6_settlements_identified: ${metrics?.phase6_settlements_identified ?? "null"}`,
    `binding_status: ${bindingResult?.binding.settlement_status ?? "not_run"}`,
    `facilitator_hash_agrees: ${bindingResult?.binding.facilitator_hash_agrees ?? "null"}`,
    `balance_identity_status: ${classification.balanceIdentityStatus ?? "null"}`,
    `safe_to_use_for_payment_verification: ${classification.safeToUseForPaymentVerification ? "yes" : "no"}`,
    "agent_signed: no",
    "strict_no_mainnet: yes",
    `detail: ${classification.detail}`,
    "NEXT",
    proven
      ? "Shared executor Sepolia regression complete; mainnet settlement core is Sepolia-proven pending human authorization."
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
