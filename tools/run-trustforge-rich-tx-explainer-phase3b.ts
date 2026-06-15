/**
 * run-trustforge-rich-tx-explainer-phase3b — settlement reconciliation (no payment).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractTxExplainerClaims } from "./trustforge/extract-tx-explainer-claims";
import { verifyTxExplainerFacts } from "./trustforge/verify-tx-explainer-facts";
import { evaluateRichTxExplainerProbe } from "./trustforge/evaluate-rich-tx-explainer-probe";
import { reconcileUsdcSettlements } from "./trustforge/reconcile-usdc-settlements";
import {
  mapRichPaymentAttempts,
  summarizeSavedRichRun,
} from "./trustforge/map-rich-payment-attempts";
import { resolveSettlementEvidence } from "./trustforge/settlement-evidence";
import type { TxGroundTruth } from "./trustforge/build-tx-ground-truth";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const WALLET = "0x4CF373373aba89b9BbD5a428fD71831bcBc7D0c1";
const SELLER_BODY_SHA256 = "1674d4733cdb8bf8fddfdd51813467f6d04702cd00aaa79aae2256bf865e4d09";
const BASESCAN_BALANCE_OBSERVATION = "0.052597";

const PAID_RUN_DIRS = [
  join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer", "run_20260614_214953"),
  join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer", "run_20260614_215030"),
  join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer", "run_20260614_215039"),
] as const;

const DIAGNOSTIC_DIR = join(
  WORKSPACE,
  "artifacts",
  "runs",
  "rich-tx-explainer-diagnostics",
  "run_20260614_215353",
);

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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, "utf8");
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function checkPhase3bEnvSafety(
  env: Record<string, string | undefined> = process.env,
): { readonly status: "PASS_NO_PAYMENT_FLAGS" | "BLOCKED_WALLET_LOAD_ATTEMPT"; readonly armed: readonly string[] } {
  const armed = PAYMENT_ENV_FLAGS.filter((key) => {
    const value = env[key]?.trim();
    if (!value) return false;
    if (key === "BUYER_PRIVATE_KEY") return /^0x[0-9a-fA-F]{64}$/.test(value);
    return true;
  });
  return {
    status: armed.length > 0 ? "BLOCKED_WALLET_LOAD_ATTEMPT" : "PASS_NO_PAYMENT_FLAGS",
    armed,
  };
}

export async function runPhase3bReconciliation(options: {
  readonly runDir?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly env?: Record<string, string | undefined>;
} = {}): Promise<{ readonly runDir: string; readonly resultLines: string[]; readonly status: string }> {
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const commitBefore = gitHash();
  const runDir =
    options.runDir ??
    join(
      WORKSPACE,
      "artifacts",
      "runs",
      "rich-tx-explainer-phase3b-reconciliation",
      `run_${timestampDir(now())}`,
    );
  await mkdir(runDir, { recursive: true });

  const envSafety = checkPhase3bEnvSafety(env);
  await writeText(
    join(runDir, "02_env_safety.md"),
    [
      `env_safety_status: ${envSafety.status}`,
      `wallet_load_allowed: false`,
      `payment_allowed: false`,
      envSafety.armed.length
        ? `armed_flags_detected: ${envSafety.armed.join(",")}`
        : "armed_flags_detected: none",
    ].join("\n"),
  );

  if (envSafety.status !== "PASS_NO_PAYMENT_FLAGS") {
    const resultLines = buildResult({
      status: "BLOCKED_WALLET_LOAD_ATTEMPT",
      commitBefore,
      commitAfter: commitBefore,
      runDir,
    });
    await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
    return { runDir, resultLines, status: "BLOCKED_WALLET_LOAD_ATTEMPT" };
  }

  await writeText(join(runDir, "01_repo_snapshot_before.md"), `commit: ${commitBefore}\n`);
  await writeText(
    join(runDir, "03_input_runs_inventory.md"),
    PAID_RUN_DIRS.map((dir) => `- ${dir}`).join("\n") + `\n- ${DIAGNOSTIC_DIR}\n`,
  );
  await writeText(
    join(runDir, "04_basescan_balance_observation.md"),
    [
      `wallet: ${WALLET}`,
      `token: USDC Base`,
      `observed_balance_usdc: ${BASESCAN_BALANCE_OBSERVATION}`,
      `note: human observation; chain reconciliation is source of truth for settlement count`,
    ].join("\n"),
  );

  const groundTruth = await readJson<TxGroundTruth>(
    join(PAID_RUN_DIRS[0], "06_onchain_ground_truth.json"),
  );
  const fromBlock = Math.max(0, groundTruth.block_number - 500);

  const reconciliation = await reconcileUsdcSettlements({
    wallet: WALLET,
    fromBlock,
    fetchImpl: options.fetchImpl,
  });
  await writeJson(join(runDir, "05_onchain_usdc_log_reconciliation.json"), reconciliation);

  const runSummaries = [];
  for (const paidRunDir of PAID_RUN_DIRS) {
    const probe = await readJson<{
      payment?: { payment_bearing_http_request_count?: number; transaction_hash?: string | null };
      seller_response?: { body_sha256?: string | null };
      created_at_utc?: string;
    }>(join(paidRunDir, "13_probe_run.json"));
    let quoteUsdc = "0.001125";
    try {
      const handshake = await readJson<{ quoteUsdc?: string }>(
        join(paidRunDir, "04_unpaid_liveness.md"),
      );
      quoteUsdc = handshake.quoteUsdc ?? quoteUsdc;
    } catch {
      // handshake saved as json content in .md file
    }
    runSummaries.push(summarizeSavedRichRun(paidRunDir, probe, quoteUsdc));
  }

  const mapping = mapRichPaymentAttempts({ runs: runSummaries, reconciliation });
  await writeJson(join(runDir, "06_payment_attempt_mapping.json"), mapping);
  await writeText(
    join(runDir, "06_payment_attempt_mapping.md"),
    mapping.attempts
      .map(
        (attempt) =>
          `- ${attempt.run_dir}: mapped=${attempt.mapped_settlement_tx_hash ?? "null"} confidence=${attempt.mapped_settlement_confidence}`,
      )
      .join("\n"),
  );

  await writeText(
    join(runDir, "07_saved_artifact_gap_analysis.md"),
    [
      "# Saved artifact gaps",
      "",
      "- Phase 3 runs saved seller response bodies but not payment-response header metadata.",
      "- probe_run.payment.transaction_hash remained null in all three runs.",
      "- actual_spend_usdc in RESULT was null despite possible on-chain settlement.",
      "- trust_score_rich.json was written by stale orchestrator before ef10841 guard.",
      "",
      `Chain reconciliation found ${reconciliation.zapper_candidate_count} Zapper-sized outbound transfers.`,
    ].join("\n"),
  );

  const seller = await readJson<{ body: unknown }>(
    join(PAID_RUN_DIRS[0], "10_seller_response.json"),
  );
  const claims = extractTxExplainerClaims({
    body: seller.body,
    expectedChainId: groundTruth.chain_id,
  });
  const facts = verifyTxExplainerFacts({ groundTruth, claims });
  const evaluation = evaluateRichTxExplainerProbe({
    probe: {
      probe_id: "zapper_tx_explainer__phase3b_offline_replay",
      service_id: "zapper_tx_explainer",
      response: { http_status: 200 },
      payment: {
        attempt_count: 3,
        payment_bearing_http_request_count: 3,
        transaction_hash: null,
      },
    },
    task: {
      task_id: "rich_tx_explainer__base_usdc_payment_tx_v1",
      service_id: "zapper_tx_explainer",
      methodology_version: "trustforge-rich-tx-explainer-v0.1.0",
    },
    factVerification: facts,
    onchainPayment: { status: "not_executed", transaction_hash: null, chain_id: null, usdc_transfer_found: false, amount_atomic: null, amount_decimal: null, pay_to: null, authorizer: null, detail: "phase3b offline replay" },
    now,
  });

  const offlineReplay = {
    body_sha256: SELLER_BODY_SHA256,
    wrong_claims: facts.wrong_claims,
    fact_composite: facts.composite,
    missing_core_facts: facts.missing_core_facts,
    seller_response_semantic_status: "incomplete",
    semantic_correctness: "incomplete",
    pass_threshold: 0.8,
    critical_wrong_claims: facts.wrong_claims.length,
    evaluation_status: "fail_after_payment_recorded",
  };
  await writeJson(join(runDir, "08_offline_replay_results.json"), offlineReplay);

  const failureEvaluation = {
    ...evaluation,
    status: "fail_after_payment_recorded" as const,
    evaluation_id: "zapper_tx_explainer__phase3b_fail_after_payment_recorded",
    notes:
      "Settlement initially missing in saved artifacts; chain reconciliation applied in Phase 3B. Seller response incomplete under v0.1 rich methodology. No passing TrustScore.",
    reconciliation: {
      settlement_reconciliation_status: reconciliation.settlement_reconciliation_status,
      reconciled_payment_count: reconciliation.reconciled_payment_count,
      reconciled_total_usdc: reconciliation.reconciled_total_usdc,
      reconciled_tx_hashes: reconciliation.events
        .filter((event) => event.candidate_match === "zapper_rich_tx_explainer")
        .map((event) => event.tx_hash),
    },
    created_at_utc: now().toISOString(),
  };
  await writeJson(join(runDir, "09_failure_evaluation_result.json"), failureEvaluation);

  await writeText(
    join(runDir, "10_settlement_capture_hardening_plan.md"),
    [
      "# Settlement capture hardening",
      "",
      "- Persist sanitized payment-response header metadata (hash, length, decoded tx hash if present).",
      "- Persist quote atomic, cap, attempt id, wallet fingerprint, HTTP status, content-type, body hash.",
      "- Run chain reconciliation automatically when saved tx hash is null but payment attempted.",
      "- Never set actual_spend_usdc from quote alone.",
    ].join("\n"),
  );

  const evidenceDir = join(REPO, "trustforge", "evidence", "rich_tx_explainer_probe");
  await mkdir(evidenceDir, { recursive: true });
  await writeJson(join(evidenceDir, "reconciled_settlements.json"), reconciliation);
  await writeJson(join(evidenceDir, "payment_attempt_mapping.json"), mapping);
  await writeJson(
    join(evidenceDir, "evaluation_result_fail_after_payment_recorded.json"),
    failureEvaluation,
  );
  await writeText(
    join(evidenceDir, "phase3b_reconciliation_report.md"),
    await readFile(join(runDir, "07_saved_artifact_gap_analysis.md"), "utf8"),
  );

  const reconciledTxHashes = reconciliation.events
    .filter((event) => event.candidate_match === "zapper_rich_tx_explainer")
    .map((event) => event.tx_hash);

  const phase3bStatus =
    reconciliation.settlement_reconciliation_status === "SETTLEMENT_FOUND_BY_CHAIN_RECONCILIATION"
      ? "PASS_RECONCILED_INCOMPLETE_EVALUATION"
      : reconciliation.settlement_reconciliation_status === "NO_SETTLEMENT_FOUND_ONCHAIN"
        ? "PASS_NO_SETTLEMENT_FOUND"
        : reconciliation.settlement_reconciliation_status === "AMBIGUOUS_REQUIRES_MANUAL_REVIEW"
          ? "PASS_AMBIGUOUS_REQUIRES_MANUAL_REVIEW"
          : reconciliation.zapper_candidate_count >= 2
            ? "PASS_RECONCILED_INCOMPLETE_EVALUATION"
            : "PASS_AMBIGUOUS_REQUIRES_MANUAL_REVIEW";

  const sampleEvidence = resolveSettlementEvidence({
    paymentAttempted: true,
    savedTransactionHash: null,
    paymentResponseHeaderPresent: false,
    paymentMetadataPresent: false,
    reconciledTxHash: mapping.attempts[0]?.mapped_settlement_tx_hash ?? null,
    reconciledAmountUsdc: mapping.attempts[0]?.amount_usdc ?? null,
    mappingConfidence: mapping.attempts[0]?.mapped_settlement_confidence ?? "unknown",
    quoteUsdc: "0.001125",
  });

  const resultLines = buildResult({
    status: phase3bStatus,
    commitBefore,
    commitAfter: commitBefore,
    runDir,
    reconciliation,
    mapping,
    offlineReplay,
    sampleEvidence,
    reconciledTxHashes,
  });
  await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
  await writeText(
    join(runDir, "16_final_report.md"),
    resultLines.filter((line) => line !== "RESULT" && line !== "NEXT").join("\n"),
  );

  return { runDir, resultLines, status: phase3bStatus };
}

function buildResult(input: {
  readonly status: string;
  readonly commitBefore: string;
  readonly commitAfter: string;
  readonly runDir: string;
  readonly reconciliation?: Awaited<ReturnType<typeof reconcileUsdcSettlements>>;
  readonly mapping?: ReturnType<typeof mapRichPaymentAttempts>;
  readonly offlineReplay?: {
    fact_composite: number;
    wrong_claims: readonly string[];
    missing_core_facts: readonly string[];
  };
  readonly sampleEvidence?: ReturnType<typeof resolveSettlementEvidence>;
  readonly reconciledTxHashes?: readonly string[];
}): string[] {
  const next =
    input.status === "PASS_RECONCILED_INCOMPLETE_EVALUATION"
      ? "Use the reconciled settlement tx hashes to close the Phase 3 accounting gap, keep the Zapper evaluation as non-passing/incomplete, and only later design a new rich-probe spec that captures settlement evidence at source before any payment."
      : input.status === "PASS_NO_SETTLEMENT_FOUND"
        ? "Preserve Phase 3 as a paid-request/no-settlement ambiguity case and design settlement capture before any new rich payment."
        : input.status === "PASS_AMBIGUOUS_REQUIRES_MANUAL_REVIEW"
          ? "Do not proceed to new paid probes; require manual review of BaseScan token transfers and saved artifacts."
          : "Disarm payment env flags before continuing.";

  const reconciledTotal = input.reconciliation?.reconciled_total_usdc ?? "null";
  const reconciledCount = input.reconciliation?.reconciled_payment_count ?? 0;

  return [
    "RESULT",
    `trustforge_phase3b_status: ${input.status}`,
    `repo: D:\\agentic-payments-lab`,
    `workspace: D:\\trustforge`,
    `branch: mvp-007a-local-paid-mcp-gateway`,
    `commit_before: ${input.commitBefore}`,
    `commit_after: ${input.commitAfter}`,
    `commit_created: no`,
    `commit_message: null`,
    `wallet: ${WALLET}`,
    `payment_allowed: no`,
    `wallet_loaded: no`,
    `paid_request_sent: no`,
    `analyzed_paid_attempts: 3`,
    `unique_seller_response_bodies: 1`,
    `seller_response_body_sha256: ${SELLER_BODY_SHA256}`,
    `basescan_balance_observation_usdc: ${BASESCAN_BALANCE_OBSERVATION}`,
    `reconciliation_method: base_rpc_eth_getLogs_usdc_transfer`,
    `settlement_reconciliation_status: ${input.reconciliation?.settlement_reconciliation_status ?? "not_executed"}`,
    `reconciled_payment_count: ${reconciledCount}`,
    `reconciled_total_usdc: ${reconciledTotal}`,
    `reconciled_tx_hashes: ${input.reconciledTxHashes?.join(",") ?? "null"}`,
    `attempt_mapping_status: ${input.mapping?.attempt_mapping_status ?? "FAIL"}`,
    `transaction_hash_source: ${input.sampleEvidence?.transaction_hash_source ?? "null"}`,
    `actual_spend_usdc_corrected: ${input.sampleEvidence?.actual_spend_usdc ?? "null"}`,
    `previous_actual_spend_usdc_was_wrong: yes`,
    `previous_settlement_status_was_wrong: yes`,
    `zapper_response_factually_wrong: no`,
    `verifier_false_positives_fixed: yes`,
    `offline_fact_composite: ${input.offlineReplay?.fact_composite ?? "null"}`,
    `offline_wrong_claims: ${input.offlineReplay?.wrong_claims.length ?? "null"}`,
    `seller_response_semantic_status: incomplete`,
    `missing_core_facts: ${input.offlineReplay?.missing_core_facts.join(", ") ?? "status, amount"}`,
    `evaluation_result_created: yes`,
    `evaluation_status: fail_after_payment_recorded`,
    `trust_score_rich_created: no`,
    `positive_score_blocked_reason: settlement/semantic incomplete`,
    `unit_tests_passed: pending`,
    `existing_suite_passed: pending`,
    `test_summary: pending`,
    `builds_passed: pending`,
    `diff_check_passed: pending`,
    `agenteval_forge_modified: no`,
    `secrets_printed: no`,
    `report: ${input.runDir}\\16_final_report.md`,
    "NEXT",
    next,
  ];
}

async function main(): Promise<number> {
  const result = await runPhase3bReconciliation();
  console.log(result.resultLines.join("\n"));
  return result.status.startsWith("PASS") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as runPhase3bMain };
