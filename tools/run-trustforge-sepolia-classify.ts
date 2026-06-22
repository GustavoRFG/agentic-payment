/**
 * run-trustforge-sepolia-classify — read-only Sepolia reconcile + PASS_SETTLED classification.
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
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
import { bindingConfirmsSettlement, resolveBindingUpperBoundUtc } from "./trustforge/settlement-run-binding";
import type { SettlementIntent } from "./trustforge/settlement-run-binding";
import { readJsonFile } from "./trustforge/bom-safe-json";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

async function findSettlementIntent(runDir: string): Promise<SettlementIntent | null> {
  if (!existsSync(runDir)) return null;
  const intentFile = readdirSync(runDir).find((name) => name.startsWith("settlement_intent_"));
  if (!intentFile) return null;
  return readJsonFile<SettlementIntent>(join(runDir, intentFile));
}

async function main(): Promise<number> {
  assertMainnetBuyerKeyAbsent();
  const runArg = process.argv.indexOf("--run-dir");
  if (runArg < 0) {
    console.error("Usage: tsx tools/run-trustforge-sepolia-classify.ts --run-dir <path> [--reuse-existing-ledger]");
    return 1;
  }
  const runDir = process.argv[runArg + 1];
  const reuseExistingLedger = process.argv.includes("--reuse-existing-ledger");
  const selected = await readJsonFile<DiscoveredSelectedCandidate>(
    join(runDir, "selected_candidate.json"),
  );
  const executionPath = join(runDir, "settlement_probe", "01_execution.json");
  if (!existsSync(executionPath)) {
    console.error("BLOCKED_NO_SETTLEMENT_EXECUTION: run human settlement probe first");
    return 1;
  }
  const execution = await readJsonFile<{
    paymentAttempted: boolean;
    paymentBearingHttpRequestCount: number;
    httpStatus: number | null;
    balanceBeforeUsdc?: string;
    facilitatorTransactionHash?: string | null;
    intentPath?: string;
    executed_at_utc?: string;
    request_completed_at_utc?: string;
  }>(executionPath);

  const reconcileDir = join(runDir, "sepolia_reconciliation");
  await mkdir(reconcileDir, { recursive: true });
  const ledgerPath = join(reconcileDir, "onchain_settlement_ledger.json");
  if (!reuseExistingLedger || !existsSync(ledgerPath)) {
    const args = [
      "tools/run-onchain-settlement-reconciliation.py",
      ...buildSepoliaReconcileArgs(selected, execution.balanceBeforeUsdc),
      "--output-dir",
      reconcileDir,
    ];
    execSync(`python ${args.map((a) => `"${a}"`).join(" ")}`, {
      cwd: REPO,
      stdio: "inherit",
      env: { ...process.env, BUYER_PRIVATE_KEY: "", SEPOLIA_BUYER_PRIVATE_KEY: "" },
    });
  } else {
    console.log(`Reusing existing ledger: ${ledgerPath}`);
  }

  const ledger = await readJsonFile<Record<string, unknown>>(ledgerPath);
  const parsed = parseReconciliationLedger(ledger);

  let bindingResult: ReturnType<typeof confirmSepoliaSettlementBinding> | null = null;
  let intent: SettlementIntent | null = null;
  if (execution.intentPath && existsSync(execution.intentPath)) {
    intent = await readJsonFile<SettlementIntent>(execution.intentPath);
  } else {
    intent = await findSettlementIntent(runDir);
  }

  const upperBoundUtc = resolveBindingUpperBoundUtc({
    executionEndUtc: execution.request_completed_at_utc ?? execution.executed_at_utc ?? null,
    classificationStartedUtc: new Date().toISOString(),
  });

  if (intent) {
    bindingResult = confirmSepoliaSettlementBinding({
      intent,
      ledger,
      facilitatorReportedHash: execution.facilitatorTransactionHash ?? null,
      upperBoundUtc,
    });
    await writeFile(
      join(runDir, `settlement_binding_${intent.attempt_id}.json`),
      `${JSON.stringify(bindingResult.binding, null, 2)}\n`,
      "utf8",
    );
  }

  const binding = bindingResult?.binding ?? null;
  const bindingConfirmed = binding ? bindingConfirmsSettlement(binding) : false;
  const independentCurrentAttemptMatch = Boolean(binding?.independent_match?.settlement_tx_hash);

  const classification = classifySepoliaSettlement({
    probe: {
      paymentAttempted: execution.paymentAttempted,
      paymentBearingHttpRequestCount: execution.paymentBearingHttpRequestCount,
      httpStatus: execution.httpStatus,
      balanceBeforeUsdc: execution.balanceBeforeUsdc,
      onChainConfirmed: bindingConfirmed && parsed.safeToUseForPaymentVerification,
      settlementTxHash: binding?.settlement_tx_hash ?? null,
    },
    reconciliationUnavailable: parsed.rpcUnavailable,
    reconciliationStatus: parsed.reconciliationStatus,
    safeToUseForPaymentVerification: parsed.safeToUseForPaymentVerification,
    unattributedSettlementsFound: parsed.unattributedSettlementsFound,
    balanceIdentityStatus: parsed.balanceIdentityStatus,
    settlementTxHash: binding?.settlement_tx_hash ?? null,
    binding,
    bindingMetrics: bindingResult?.metrics ?? null,
  });

  await writeFile(
    join(runDir, "sepolia_classification.json"),
    `${JSON.stringify(classification, null, 2)}\n`,
    "utf8",
  );

  const proven = classification.outcome === "PASS_SETTLED";
  const metrics = bindingResult?.metrics;
  const partialTemporalFix =
    classification.outcome === "SETTLED_ONCHAIN_FACILITATOR_HASH_MISSING" &&
    independentCurrentAttemptMatch;

  const resultBanner = proven
    ? "SEPOLIA_SETTLEMENT_PROVEN"
    : partialTemporalFix
      ? "PHASE62_BINDING_TEMPORAL_FIX_PASS_FACILITATOR_RECEIPT_MISSING"
      : `sepolia_classification_status: ${classification.outcome}`;

  const lines = [
    "RESULT",
    resultBanner,
    `run_dir: ${runDir}`,
    `current_attempt_id: ${intent?.attempt_id ?? "null"}`,
    `paid_probe_outcome: ${classification.outcome}`,
    `settlement_tx_hash: ${classification.settlementTxHash ?? "null"}`,
    `reconciliation_status: ${classification.reconciliationStatus ?? "null"}`,
    `independent_current_attempt_match: ${independentCurrentAttemptMatch ? "found" : "not_found"}`,
    `unattributed_settlements_found: ${metrics?.unattributed_settlements_found ?? classification.unattributedSettlementsFound ?? "null"}`,
    `total_outflow_settlements_found: ${metrics?.total_outflow_settlements_found ?? "null"}`,
    `current_attempt_candidates_after_filter: ${metrics?.current_attempt_candidates_after_filter ?? "null"}`,
    `known_settlements_confirmed_onchain: ${metrics?.known_settlements_confirmed_onchain ?? "null"}`,
    `phase6_settlements_identified: ${metrics?.phase6_settlements_identified ?? "null"}`,
    `current_attempt_settlement_block: ${metrics?.current_attempt_settlement_block ?? "null"}`,
    `binding_status: ${binding?.settlement_status ?? "not_run"}`,
    `facilitator_hash_cross_check: ${binding?.facilitator_hash_cross_check ?? "null"}`,
    `facilitator_hash_agrees: ${binding?.facilitator_hash_agrees ?? "null"}`,
    `balance_identity_status: ${classification.balanceIdentityStatus ?? "null"}`,
    `safe_to_use_for_payment_verification: ${classification.safeToUseForPaymentVerification ? "yes" : "no"}`,
    "agent_signed: no",
    "strict_no_mainnet: yes",
    `detail: ${classification.detail}`,
    "NEXT",
    proven
      ? "Shared executor Sepolia regression complete; mainnet settlement core is Sepolia-proven pending human authorization."
      : partialTemporalFix
        ? "Temporal binding fixed; facilitator receipt missing in preserved artifacts — future human regression required for strict Phase 6.2 proof."
        : classification.outcome === "PASS_NO_SETTLE_CLEAN"
          ? "Happy path not proven — do not retry without new authorization."
          : "Resolve blocker; do not retry-grind.",
  ];
  await writeFile(join(runDir, "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");
  console.log(lines.join("\n"));
  return proven || partialTemporalFix ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
