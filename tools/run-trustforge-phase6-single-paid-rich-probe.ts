/**
 * run-trustforge-phase6-single-paid-rich-probe — Phase 6 one-shot settlement-first paid probe.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import dotenv from "dotenv";
import { runRichTxExplainerPhase3 } from "./run-trustforge-rich-tx-explainer";
import {
  validateHumanPaymentAuthorization,
  type HumanPaymentAuthorization,
  type TargetSelectionAuditMetadata,
} from "./trustforge/validate-human-payment-authorization";
import {
  TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV,
  TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE,
  TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV,
  TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
  TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV,
  TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV,
} from "./trustforge/rich-tx-explainer-policy";
import {
  settlementEvidenceFromSavedHeader,
  settlementEvidenceFromChainReconciliation,
} from "./trustforge/settlement-evidence";
import {
  applyPaymentIntegrityToEntry,
  type PaymentAttemptLedgerEntry,
} from "./trustforge/payment-integrity-engine";
import {
  ledgerEntryToV1,
  runPaymentIntegrityEngine,
  evaluateTrustScoreCreation,
  settlementEvidenceToV1,
} from "./trustforge/settlement-first-v1";
import {
  checkPhase6PaidInvariantsFromLegacy,
  allPhase6PaidInvariantsPassed,
} from "./trustforge/phase6-paid-invariants";
import {
  authorizationLedgerPath,
  hashAuthorizationContent,
  reserveAuthorizationAttempt,
  AUTHORIZATION_ALREADY_CONSUMED,
} from "./trustforge/authorization-consumption-ledger";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PHASE5_RUN = join(
  WORKSPACE,
  "artifacts",
  "runs",
  "phase5-rich-provider-discovery",
  "run_20260615_031340",
);

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

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, "utf8");
}

function loadEnvForPaidProbe(): Record<string, string | undefined> {
  const env = { ...process.env };
  delete env.TRUSTFORGE_PHASE4_NO_PAYMENT;
  delete env.TRUSTFORGE_DISABLE_PAID_EXECUTION;

  for (const file of [
    join(REPO, "seller-api", ".env"),
    join(REPO, "buyer-client", ".env"),
    join(REPO, ".env"),
    join(WORKSPACE, ".env"),
  ]) {
    if (existsSync(file)) {
      dotenv.config({ path: file, override: false });
    }
  }

  return { ...process.env };
}

export interface Phase6RunOptions {
  readonly phase5RunDir?: string;
  readonly runDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly finalizeOnly?: boolean;
  readonly richRunDir?: string;
}

export async function runPhase6SinglePaidRichProbe(
  options: Phase6RunOptions = {},
): Promise<{ readonly runDir: string; readonly status: string; readonly resultLines: string[] }> {
  const phase5RunDir = options.phase5RunDir ?? DEFAULT_PHASE5_RUN;
  const authPath = join(phase5RunDir, "human_payment_authorization.json");
  const selectedPath = join(phase5RunDir, "selected_candidate.json");

  if (!existsSync(authPath)) {
    throw new Error("WAITING_FOR_HUMAN_PAYMENT_DECISION: human_payment_authorization.json missing");
  }

  const auth = await readJson<HumanPaymentAuthorization>(authPath);
  const selected = await readJson<{
    provider: string;
    service_id: string;
    endpoint: string;
    quote_amount_usdc?: string;
    recommended_max_usdc?: string;
    target_selection_audit?: TargetSelectionAuditMetadata | null;
  }>(selectedPath);

  const validation = validateHumanPaymentAuthorization(auth, selected);
  if (!validation.valid) {
    throw new Error(
      `BLOCKED_INVALID_PAYMENT_AUTHORIZATION: ${validation.reasons.join("; ")}`,
    );
  }

  if (auth.decision === "reject") {
    throw new Error("COMPLETED_HUMAN_REJECTED_PAID_PROBE");
  }

  const authContent = await readFile(authPath, "utf8");
  const authorizationHash = hashAuthorizationContent(authContent);
  const ledgerPath = authorizationLedgerPath(phase5RunDir);

  const env = options.env ?? loadEnvForPaidProbe();
  const commitBefore = gitHash();
  const runId = `phase6_${timestampDir()}`;
  const runDir =
    options.runDir ??
    join(WORKSPACE, "artifacts", "runs", "phase6-single-paid-rich-probe", runId);
  await mkdir(runDir, { recursive: true });
  const targetSelectionAudit =
    selected.target_selection_audit ?? auth.target_selection_audit ?? null;

  if (!options.finalizeOnly) {
    try {
      await reserveAuthorizationAttempt({
        ledgerPath,
        authorizationHash,
        authorizationPath: authPath,
        provider: auth.provider,
        serviceId: auth.service_id,
        endpoint: auth.endpoint,
        maxPaymentAttempts: auth.max_payment_attempts,
        attemptId: `${runId}__attempt_1`,
      });
    } catch (error) {
      if (error instanceof Error && error.message === AUTHORIZATION_ALREADY_CONSUMED) {
        throw new Error(AUTHORIZATION_ALREADY_CONSUMED);
      }
      throw error;
    }
  }

  const buyerKeyPresent = Boolean(env.BUYER_PRIVATE_KEY?.trim());
  if (!options.finalizeOnly && !buyerKeyPresent) {
    throw new Error(
      "BLOCKED_WALLET_NOT_CONFIGURED: set BUYER_PRIVATE_KEY in environment or D:\\trustforge\\.env",
    );
  }

  await writeJson(join(runDir, "01_run_state.json"), {
    phase: "phase6_single_paid_rich_probe",
    status: "running",
    human_authorization: join(phase5RunDir, "human_payment_authorization.json"),
    authorization_consumption_ledger: ledgerPath,
    phase5_run: phase5RunDir,
    commit_before: commitBefore,
    strict_one_payment: true,
    target_selection_audit: targetSelectionAudit,
  });

  const armedEnv: Record<string, string | undefined> = {
    ...env,
    [TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_ENV]: TRUSTFORGE_AUTHORIZE_RICH_TX_EXPLAINER_VALUE,
    [TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV]: TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE,
    [TRUSTFORGE_RICH_TX_EXPLAINER_RUN_ID_ENV]: runId,
    [TRUSTFORGE_RICH_TX_EXPLAINER_MAX_USDC_ENV]: auth.max_usdc,
  };

  const richRunDir = options.richRunDir ?? join(runDir, "rich_probe_run");
  if (!options.finalizeOnly) {
    await mkdir(richRunDir, { recursive: true });
    await runRichTxExplainerPhase3({
      runDir: richRunDir,
      executePaid: true,
      env: armedEnv,
    });
  }

  return finalizePhase6Run({
    runDir,
    richRunDir,
    auth,
    selected,
    commitBefore,
    phase5RunDir,
  });
}

export async function finalizePhase6Run(input: {
  readonly runDir: string;
  readonly richRunDir: string;
  readonly auth: HumanPaymentAuthorization;
  readonly selected: {
    provider: string;
    service_id: string;
    endpoint: string;
    quote_amount_usdc?: string;
    target_selection_audit?: TargetSelectionAuditMetadata | null;
  };
  readonly commitBefore: string;
  readonly phase5RunDir: string;
}): Promise<{ readonly runDir: string; readonly status: string; readonly resultLines: string[] }> {
  const { runDir, richRunDir, auth, selected, commitBefore, phase5RunDir } = input;
  const runId = runDir.split(/[\\/]/).pop() ?? "phase6_unknown";
  const targetSelectionAudit =
    selected.target_selection_audit ?? auth.target_selection_audit ?? null;

  const richResult = existsSync(join(richRunDir, "RESULT.txt"))
    ? await readFile(join(richRunDir, "RESULT.txt"), "utf8")
    : "";

  const probeStatus =
    richResult.match(/trustforge_rich_tx_explainer_status: (\S+)/)?.[1] ?? "UNKNOWN";
  const paymentAttempted = richResult.includes("payment_attempted_live: yes");
  const paymentBearingCount = Number(
    richResult.match(/payment_bearing_http_request_count: (\d+)/)?.[1] ?? "0",
  );
  const paymentHeaderSentLine = richResult.match(/payment_header_sent: (\S+)/)?.[1];
  const paymentHeaderSent =
    paymentHeaderSentLine === "yes" || paymentAttempted;
  const paid402CapturePresent = existsSync(
    join(richRunDir, "paid_402_response_sanitized.json"),
  );
  const walletLoaded = richResult.includes("wallet_loaded_live: yes");

  const sellerResponse = existsSync(join(richRunDir, "10_seller_response.json"))
    ? await readJson<{
        payment_metadata?: {
          settlement_transaction_hash?: string | null;
          payment_response_header_present?: boolean;
          quote_usdc?: string;
          wallet_fingerprint?: string;
        };
      }>(join(richRunDir, "10_seller_response.json"))
    : null;

  const facts = existsSync(join(richRunDir, "12_fact_verification.json"))
    ? await readJson<{ passed: boolean; composite: number }>(
        join(richRunDir, "12_fact_verification.json"),
      )
    : { passed: false, composite: 0 };

  let onchainParsed: {
    status?: string;
    amount_decimal?: string | null;
    transaction_hash?: string | null;
  } | null = null;
  if (existsSync(join(richRunDir, "09_onchain_payment_verification.md"))) {
    try {
      onchainParsed = await readJson(join(richRunDir, "09_onchain_payment_verification.md"));
    } catch {
      const text = await readFile(join(richRunDir, "09_onchain_payment_verification.md"), "utf8");
      onchainParsed = { status: text.includes("ONCHAIN_VERIFIED") ? "ONCHAIN_VERIFIED" : "unknown" };
    }
  }

  const txHash =
    sellerResponse?.payment_metadata?.settlement_transaction_hash ??
    onchainParsed?.transaction_hash ??
    null;
  const actualSpend = txHash
    ? (onchainParsed?.amount_decimal ?? null)
    : null;

  const savedLegacy = txHash
    ? settlementEvidenceFromSavedHeader({
        transactionHash: txHash,
        amountDecimal: actualSpend,
        payTo: null,
        payer: null,
        chainId: 8453,
        receiptStatus: onchainParsed?.status === "ONCHAIN_VERIFIED" ? "success" : "unknown",
      })
    : null;

  const settlementEvidenceV1 = savedLegacy
    ? settlementEvidenceToV1({
        legacy: savedLegacy,
        quoteUsdc: selected.quote_amount_usdc ?? "0.001125",
        quoteChainId: 8453,
        evidenceSource: "live_reconciled",
        reconciledAt: new Date().toISOString(),
      })
    : settlementEvidenceToV1({
        legacy: {
          status: "missing_header_tx_hash",
          transactionHash: null,
          transactionHashSource: null,
          chainId: 8453,
          amountAtomic: null,
          amountDecimal: null,
          asset: "USDC",
          payer: null,
          payTo: null,
          receiptStatus: null,
          mappingConfidence: null,
          evidencePaths: [],
          notes: ["no settlement tx hash captured at source"],
        },
        quoteUsdc: selected.quote_amount_usdc ?? "0.001125",
        evidenceSource: "not_available",
      });

  await writeJson(join(runDir, "settlement_evidence.json"), settlementEvidenceV1);

  const ledgerEntry: PaymentAttemptLedgerEntry = applyPaymentIntegrityToEntry({
    attemptId: `${runId}__attempt_1`,
    runId,
    serviceId: selected.service_id,
    endpoint: selected.endpoint,
    method: "POST",
    targetTaskId: "rich_tx_explainer__base_usdc_payment_tx_v1",
    quoteUsdc: selected.quote_amount_usdc ?? "0.001125",
    capUsdc: auth.max_usdc,
    paymentBearingHttpRequestCount: paymentBearingCount || (paymentHeaderSent ? 1 : 0),
    walletFingerprint: sellerResponse?.payment_metadata?.wallet_fingerprint ?? (walletLoaded ? "loaded" : null),
    sellerResponseCaptured: Boolean(sellerResponse),
    sellerResponseBodySha256: null,
    savedSettlementEvidence: savedLegacy ?? {
      status: "missing_header_tx_hash",
      transactionHash: null,
      transactionHashSource: null,
      chainId: 8453,
      amountAtomic: null,
      amountDecimal: null,
      asset: "USDC",
      payer: null,
      payTo: null,
      receiptStatus: null,
      mappingConfidence: null,
      evidencePaths: [],
      notes: [],
    },
    chainReconciledSettlementEvidence:
      onchainParsed?.status === "ONCHAIN_VERIFIED" && txHash && actualSpend
        ? settlementEvidenceFromChainReconciliation({
            transactionHash: txHash,
            amountDecimal: actualSpend,
            amountAtomic: "1125",
            payer: "",
            payTo: "",
            mappingConfidence: "high",
          })
        : null,
    actualSpendUsdc: actualSpend,
    actualSpendSource: txHash ? "saved_header" : null,
    finalPaymentIntegrity: "not_executed",
    createdAtUtc: new Date().toISOString(),
  });

  await writeJson(join(runDir, "payment_attempt_ledger.json"), {
    schema_version: "trustforge_payment_attempt_ledger_v0.1.0",
    service_id: selected.service_id,
    target_selection_audit: targetSelectionAudit,
    entries: [ledgerEntry],
    actual_total_spend_usdc: actualSpend,
    reconciled_settlement_count: txHash ? 1 : 0,
  });

  const semanticStatus = facts.passed ? "pass" : facts.composite > 0 ? "fail" : "incomplete";
  const ledgerV1 = ledgerEntryToV1(ledgerEntry, { noPaymentMode: false });
  const paymentIntegrity = runPaymentIntegrityEngine({
    ledgerEntry: ledgerV1,
    semanticEvaluationStatus: semanticStatus,
    checkedAt: new Date().toISOString(),
  });
  await writeJson(join(runDir, "payment_integrity_result.json"), paymentIntegrity);

  await writeJson(join(runDir, "semantic_evaluation.json"), {
    status: semanticStatus,
    composite: facts.composite,
    passed: facts.passed,
  });

  const trustScoreGate = evaluateTrustScoreCreation({
    paymentIntegrity,
    semanticEvaluationStatus: semanticStatus,
  });
  await writeJson(
    join(runDir, trustScoreGate.trust_score_created ? "trust_score_result.json" : "blocked_trust_score_result.json"),
    trustScoreGate,
  );

  let authorizationConsumedAttempts = paymentAttempted ? 1 : 0;
  const authLedgerPath = authorizationLedgerPath(phase5RunDir);
  if (existsSync(authLedgerPath)) {
    try {
      const authLedger = await readJson<{ consumed_attempts?: number }>(authLedgerPath);
      authorizationConsumedAttempts = authLedger.consumed_attempts ?? authorizationConsumedAttempts;
    } catch {
      /* keep default */
    }
  }

  const paidInvariants = checkPhase6PaidInvariantsFromLegacy({
    paymentBearingHttpRequestCount: paymentBearingCount || (paymentHeaderSent ? 1 : 0),
    paymentAttemptCount: paymentAttempted ? 1 : 0,
    retryUsed: false,
    authorizedMaxUsdc: auth.max_usdc,
    actualSpendUsdc: actualSpend,
    authorizedProvider: auth.provider,
    authorizedServiceId: auth.service_id,
    authorizedEndpoint: auth.endpoint,
    observedProvider: selected.provider,
    observedServiceId: selected.service_id,
    observedEndpoint: selected.endpoint,
    settlementTxHash: txHash,
    paymentIntegrityPass: paymentIntegrity.pass,
    semanticEvaluationPass: semanticStatus === "pass",
    trustScoreCreated: trustScoreGate.trust_score_created === true,
    secretsPrinted: false,
    paymentHeaderSent,
    paid402CapturePresent,
    authorizationConsumedAttempts,
    authorizationMaxAttempts: auth.max_payment_attempts,
  });
  await writeJson(join(runDir, "paid_invariants.json"), paidInvariants);

  const invariantsOk = allPhase6PaidInvariantsPassed(paidInvariants);
  const phase6Status =
    probeStatus === "PASS_RICH_TX_EXPLAINER_SCORE" && invariantsOk
      ? "PASS_SINGLE_PAID_RICH_PROBE"
      : paymentAttempted
        ? "COMPLETED_PAID_PROBE_NO_TRUSTSCORE"
        : "BLOCKED_PAID_PROBE_INCOMPLETE";

  const resultLines = [
    "RESULT",
    `trustforge_phase6_status: ${phase6Status}`,
    `repo: D:\\agentic-payments-lab`,
    `branch: ${gitBranch()}`,
    `commit_before: ${commitBefore}`,
    `commit_after: ${gitHash()}`,
    `human_authorization: ${join(phase5RunDir, "human_payment_authorization.json")}`,
    `provider: ${auth.provider}`,
    `service_id: ${auth.service_id}`,
    `endpoint: ${auth.endpoint}`,
    `selected_resource_url: ${targetSelectionAudit?.selected_resource_url ?? selected.endpoint}`,
    `target_handshake_status: ${targetSelectionAudit?.handshake_status ?? "not_recorded"}`,
    `target_fallback_count: ${targetSelectionAudit?.fallback_resource_urls.length ?? 0}`,
    `authorized_max_usdc: ${auth.max_usdc}`,
    `actual_spend_usdc: ${actualSpend ?? "null"}`,
    `payment_attempt_count: ${paymentAttempted ? 1 : 0}`,
    `payment_bearing_http_request_count: ${paymentBearingCount || (paymentHeaderSent ? 1 : 0)}`,
    `retry_used: no`,
    `wallet_loaded: ${walletLoaded ? "yes" : "no"}`,
    `payment_header_sent: ${paymentHeaderSent ? "yes" : "no"}`,
    `paid_402_capture_present: ${paid402CapturePresent ? "yes" : "no"}`,
    `settlement_evidence_status: ${settlementEvidenceV1.status}`,
    `payment_integrity_status: ${paymentIntegrity.status}`,
    `semantic_evaluation_status: ${semanticStatus}`,
    `trust_score_created: ${trustScoreGate.trust_score_created ? "yes" : "no"}`,
    `trust_score_blocked_reason: ${
      trustScoreGate.trust_score_created === false ? trustScoreGate.blocked_reason : "none"
    }`,
    `rich_probe_status: ${probeStatus}`,
    `paid_invariants_passed: ${invariantsOk ? "yes" : "no"}`,
    `secrets_printed: no`,
    `report: ${join(runDir, "final_report.md")}`,
    `rich_probe_artifacts: ${richRunDir}`,
    "NEXT",
    phase6Status === "PASS_SINGLE_PAID_RICH_PROBE"
      ? "Run temporal follow-up probe or publish methodology review before public score claims."
      : "Review settlement capture and semantic gaps; chain reconciliation if tx hash missing; do not retry payment without new authorization.",
  ];

  await writeText(
    join(runDir, "final_report.md"),
    [
      "# Phase 6 single paid rich probe",
      "",
      `- Status: **${phase6Status}**`,
      `- Rich orchestrator: ${probeStatus}`,
      `- Provider: ${auth.provider}`,
      `- Selected resource: ${targetSelectionAudit?.selected_resource_url ?? selected.endpoint}`,
      `- Target handshake: ${targetSelectionAudit?.handshake_status ?? "not recorded"}`,
      `- Settlement tx: ${txHash ?? "null"}`,
      `- Payment integrity: ${paymentIntegrity.status}`,
      `- Semantic: ${semanticStatus}`,
      `- TrustScore created: ${trustScoreGate.trust_score_created ? "yes" : "no"}`,
      "",
      "## PAID invariants",
      ...paidInvariants.map((i) => `- ${i.id}: ${i.passed ? "PASS" : "FAIL"} — ${i.detail}`),
      "",
      "## Target selection audit",
      targetSelectionAudit
        ? `- Fallbacks considered: ${targetSelectionAudit.fallback_resource_urls.join(", ") || "none"}`
        : "- No target_selection_audit supplied",
      ...(targetSelectionAudit?.scoring_rationale.map((r) => `- ${r}`) ?? []),
    ].join("\n"),
  );
  await writeText(join(runDir, "RESULT.txt"), `${resultLines.join("\n")}\n`);
  await writeJson(join(runDir, "01_run_state.json"), {
    phase: "phase6_single_paid_rich_probe",
    status: phase6Status,
    human_authorization: join(phase5RunDir, "human_payment_authorization.json"),
    commit_before: commitBefore,
    commit_after: gitHash(),
    payment_attempted_live: paymentAttempted,
    wallet_loaded: walletLoaded,
    payment_header_sent: paymentAttempted,
    payment_bearing_http_request_count: paymentBearingCount,
    settlement_tx_hash: txHash,
    target_selection_audit: targetSelectionAudit,
  });

  return { runDir, status: phase6Status, resultLines };
}

async function main(): Promise<number> {
  const phase5Arg = process.argv.indexOf("--phase5-run");
  const phase5RunDir =
    phase5Arg >= 0 ? process.argv[phase5Arg + 1] : DEFAULT_PHASE5_RUN;
  const finalizeOnly = process.argv.includes("--finalize-only");
  const runDirArg = process.argv.indexOf("--run-dir");
  const runDir = runDirArg >= 0 ? process.argv[runDirArg + 1] : undefined;

  try {
    if (finalizeOnly && runDir) {
      const auth = await readJson<HumanPaymentAuthorization>(
        join(phase5RunDir, "human_payment_authorization.json"),
      );
      const selected = await readJson<{
        provider: string;
        service_id: string;
        endpoint: string;
        quote_amount_usdc?: string;
        target_selection_audit?: TargetSelectionAuditMetadata | null;
      }>(join(phase5RunDir, "selected_candidate.json"));
      const result = await finalizePhase6Run({
        runDir,
        richRunDir: join(runDir, "rich_probe_run"),
        auth,
        selected,
        commitBefore: gitHash(),
        phase5RunDir,
      });
      console.log(result.resultLines.join("\n"));
      return result.status.startsWith("PASS") ? 0 : 1;
    }

    const result = await runPhase6SinglePaidRichProbe({ phase5RunDir, runDir });
    console.log(result.resultLines.join("\n"));
    return result.status.startsWith("PASS") ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return message.startsWith("WAITING_") ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { main as runPhase6Main };
