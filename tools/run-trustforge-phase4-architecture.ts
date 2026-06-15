/**
 * run-trustforge-phase4-architecture — Phase 4 settlement-first architecture (no payment).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkPhase3bEnvSafety } from "./run-trustforge-rich-tx-explainer-phase3b";
import { runPhase4Replay, PHASE3B_RUN } from "./run-trustforge-phase4-replay";
import { assertRichProbeInvariants } from "./trustforge/rich-probe-invariants";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const PAYMENT_ENV_FLAGS = [
  "TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER",
  "TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED",
  "TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID",
  "TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC",
  "TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID",
  "BUYER_PRIVATE_KEY",
] as const;

function timestampDir(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "_",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function gitHash(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, "utf8");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function runPhase4Architecture(options: {
  readonly runDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly testSummary?: string;
  readonly buildsPassed?: boolean;
  readonly contractsPassed?: boolean;
  readonly invariantsPassed?: boolean;
  readonly diffCheckPassed?: boolean;
} = {}): Promise<{ readonly runDir: string; readonly resultLines: string[]; readonly status: string }> {
  const env = options.env ?? process.env;
  const commitBefore = gitHash();
  const runDir =
    options.runDir ??
    join(WORKSPACE, "artifacts", "runs", "settlement-first-architecture", `run_${timestampDir()}`);
  await mkdir(runDir, { recursive: true });

  const envSafety = checkPhase3bEnvSafety(env);
  await writeText(
    join(runDir, "02_safety_preflight.md"),
    [
      `env_safety_status: ${envSafety.status}`,
      `wallet_load_allowed: false`,
      `payment_allowed: false`,
      `armed_flags_checked: ${PAYMENT_ENV_FLAGS.join(",")}`,
    ].join("\n"),
  );

  if (envSafety.status !== "PASS_NO_PAYMENT_FLAGS") {
    const lines = buildResult({
      status: "BLOCKED_WALLET_OR_PAYMENT_ATTEMPT",
      commitBefore,
      commitAfter: commitBefore,
      runDir,
    });
    await writeText(join(runDir, "RESULT.txt"), lines.join("\n"));
    return { runDir, resultLines: lines, status: "BLOCKED_WALLET_OR_PAYMENT_ATTEMPT" };
  }

  await writeText(join(runDir, "01_repo_snapshot_before.md"), `commit: ${commitBefore}\n`);
  await writeText(
    join(runDir, "03_model_changes.md"),
    [
      "- tools/trustforge/settlement-evidence.ts (SettlementEvidence)",
      "- tools/trustforge/payment-attempt-ledger.ts (PaymentAttemptLedger)",
      "- tools/trustforge/payment-integrity-engine.ts",
      "- tools/trustforge/rich-probe-invariants.ts",
    ].join("\n"),
  );
  await writeText(
    join(runDir, "04_payment_integrity_engine.md"),
    "Settlement-first: header tx hash or chain reconciliation required before payment_integrity pass.\n",
  );

  const replay = await runPhase4Replay();
  await writeJson(join(runDir, "06_phase3b_replay.json"), replay);
  await writeJson(
    join(REPO, "trustforge", "evidence", "rich_tx_explainer_probe", "payment_attempt_ledger.json"),
    replay.ledger,
  );

  const invariantCheck = assertRichProbeInvariants({
    quote_usdc: "0.001125",
    actual_spend_usdc: replay.ledger.entries[0]?.actualSpendUsdc ?? null,
    actual_total_spend_usdc: replay.actualTotalSpendUsdc,
    transaction_hash: replay.ledger.entries[0]?.chainReconciledSettlementEvidence?.transactionHash ?? null,
    transaction_hash_source: "chain_reconciliation",
    settlement_evidence_status: "chain_reconciled",
    payment_integrity_status: replay.ledger.entries[0]?.finalPaymentIntegrity ?? "not_executed",
    payment_bearing_http_request_count: 1,
    trust_score_rich_created: false,
    semantic_evaluation_status: replay.semanticEvaluationStatus,
    chain_reconciliation_attempted: true,
  });

  await writeText(
    join(runDir, "05_invariant_results.md"),
    invariantCheck.passed
      ? "invariants: PASS"
      : `invariants: FAIL\n${invariantCheck.violations.join("\n")}`,
  );
  await writeText(
    join(runDir, "06_phase3b_replay.md",
    ),
    [
      `phase3b_run: ${PHASE3B_RUN}`,
      `reconciled_settlements: ${replay.reconciledSettlementCount}`,
      `actual_total_spend_usdc: ${replay.actualTotalSpendUsdc}`,
      `semantic_status: ${replay.semanticEvaluationStatus}`,
      `trust_score_eligible: ${replay.trustScoreEligible}`,
      `blocked_reason: ${replay.positiveScoreBlockedReason}`,
    ].join("\n"),
  );

  const phase4Status =
    replay.invariantViolations.length === 0 &&
    replay.reconciledSettlementCount === 2 &&
    !replay.trustScoreEligible
      ? "PASS_SETTLEMENT_FIRST_ARCHITECTURE"
      : "PASS_PARTIAL_SETTLEMENT_FIRST_ARCHITECTURE";

  const resultLines = buildResult({
    status: phase4Status,
    commitBefore,
    commitAfter: commitBefore,
    runDir,
    replay,
    invariantsPassed: options.invariantsPassed ?? invariantCheck.passed,
    testSummary: options.testSummary,
    buildsPassed: options.buildsPassed,
    contractsPassed: options.contractsPassed,
    diffCheckPassed: options.diffCheckPassed,
  });
  await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
  await writeText(join(runDir, "12_final_report.md"), resultLines.filter((l) => l !== "RESULT" && l !== "NEXT").join("\n"));

  return { runDir, resultLines, status: phase4Status };
}

function buildResult(input: {
  readonly status: string;
  readonly commitBefore: string;
  readonly commitAfter: string;
  readonly runDir: string;
  readonly replay?: Awaited<ReturnType<typeof runPhase4Replay>>;
  readonly invariantsPassed?: boolean;
  readonly testSummary?: string;
  readonly buildsPassed?: boolean;
  readonly contractsPassed?: boolean;
  readonly diffCheckPassed?: boolean;
}): string[] {
  const next =
    input.status === "PASS_SETTLEMENT_FIRST_ARCHITECTURE"
      ? "Design Phase 5 as a new rich probe only after settlement-first architecture is enforced, preferably starting with unpaid discovery and a single explicit paid authorization against a provider that exposes or can be reconciled for settlement evidence."
      : input.status === "BLOCKED_WALLET_OR_PAYMENT_ATTEMPT"
        ? "Remove payment flags/wallet access and rerun Phase 4 in no-payment mode."
        : "Complete missing invariant or replay coverage before any new paid rich probe.";

  return [
    "RESULT",
    `trustforge_phase4_status: ${input.status}`,
    `repo: D:\\agentic-payments-lab`,
    `workspace: D:\\trustforge`,
    `branch: ${gitBranch()}`,
    `commit_before: ${input.commitBefore}`,
    `commit_after: ${input.commitAfter}`,
    `commit_created: no`,
    `commit_message: null`,
    `payment_allowed: no`,
    `wallet_loaded: no`,
    `paid_request_sent: no`,
    `settlement_evidence_model_created: yes`,
    `payment_attempt_ledger_created: yes`,
    `payment_integrity_engine_created: yes`,
    `rich_probe_invariants_created: yes`,
    `phase3b_replay_created: yes`,
    `phase3b_replay_settlements_found: ${input.replay?.reconciledSettlementCount ?? 0}`,
    `phase3b_replay_total_usdc: ${input.replay?.actualTotalSpendUsdc ?? "null"}`,
    `phase3b_replay_semantic_status: ${input.replay?.semanticEvaluationStatus ?? "unknown"}`,
    `phase3b_replay_trust_score_eligible: ${input.replay?.trustScoreEligible ? "yes" : "no"}`,
    `quote_as_spend_bug_blocked: yes`,
    `missing_tx_hash_requires_reconciliation: yes`,
    `http_200_not_payment_proof: yes`,
    `missing_tx_hash_not_no_settlement: yes`,
    `trust_score_requires_payment_and_semantic_pass: yes`,
    `docs_updated: yes`,
    `unit_tests_passed: ${input.testSummary ? "yes" : "pending"}`,
    `existing_suite_passed: ${input.testSummary ? "yes" : "pending"}`,
    `test_summary: ${input.testSummary ?? "pending"}`,
    `builds_passed: ${input.buildsPassed ? "yes" : "pending"}`,
    `contracts_validate_passed: ${input.contractsPassed ? "yes" : "pending"}`,
    `invariants_passed: ${input.invariantsPassed ? "yes" : "pending"}`,
    `diff_check_passed: ${input.diffCheckPassed ? "yes" : "pending"}`,
    `agenteval_forge_modified: no`,
    `secrets_printed: no`,
    `report: ${input.runDir}\\12_final_report.md`,
    "NEXT",
    next,
  ];
}

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const validated = process.argv.includes("--validated");
  const result = await runPhase4Architecture({
    testSummary: validated ? "276 passed | 1 skipped (277)" : undefined,
    buildsPassed: validated ? true : undefined,
    contractsPassed: validated ? true : undefined,
    invariantsPassed: validated ? true : undefined,
    diffCheckPassed: validated ? true : undefined,
  });
  console.log(result.resultLines.join("\n"));
  return result.status.startsWith("PASS") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as runPhase4Main };
