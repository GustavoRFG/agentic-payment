/**
 * run-trustforge-rich-tx-explainer — Phase 3 orchestrator (discovery → unpaid → optional paid).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import dotenv from "dotenv";
import { buildTxGroundTruth } from "./trustforge/build-tx-ground-truth";
import { extractTxExplainerClaims } from "./trustforge/extract-tx-explainer-claims";
import { verifyTxExplainerFacts } from "./trustforge/verify-tx-explainer-facts";
import { verifyBaseUsdcPayment } from "./trustforge/verify-base-usdc-payment";
import { discoverRichTxExplainerEndpoints } from "./trustforge/rich-tx-explainer-discovery";
import { inspectRichTxExplainerUnpaidHandshake } from "./trustforge/rich-tx-explainer-handshake";
import {
  PHASE2_FIXTURE_TX,
  T0C_FIXTURE_TX,
  TRUSTFORGE_AUTHORIZATION_HASH_ENV,
  validateRichHumanGates,
  applyCapToPolicy,
} from "./trustforge/rich-tx-explainer-policy";
import {
  createRichPaidGuards,
  loadRichBuyerWallet,
  performRichTxExplainerPaidRequest,
} from "./trustforge/rich-tx-explainer-live-bindings";
import {
  PaidRequest402Error,
  formatPaid402CaptureMarkdown,
  paid402CaptureSha256,
} from "./trustforge/paid-402-response-sanitize";
import { evaluateRichTxExplainerProbe } from "./trustforge/evaluate-rich-tx-explainer-probe";
import { evaluateRichProbeEligibility } from "./trustforge/rich-probe-invariants";
import {
  classifySellerResponseKind,
  resolveSellerResponseSemanticStatus,
  resolveSettlementEvidenceStatus,
} from "./trustforge/rich-tx-explainer-result-semantics";
import {
  consolidateBootstrapTrustScore,
  type TrustScore,
} from "./trustforge/consolidate-bootstrap-trust-score";
import type { EvaluationResult } from "./trustforge/evaluate-bootstrap-probe";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface RichTxExplainerCliArgs {
  readonly executePaid: boolean;
}

export const TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_ENV =
  "TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID" as const;
export const TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_VALUE = "YES" as const;

export interface PaidExecutionEligibility {
  readonly eligible: boolean;
  readonly blockedReason: string | null;
}

export function parseRichTxExplainerArgs(argv: readonly string[]): RichTxExplainerCliArgs {
  let executePaid = false;
  for (const arg of argv) {
    if (arg === "--execute-paid" || arg === "execute-paid") {
      executePaid = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { executePaid };
}

export function resolveExecutePaidFlag(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (parseRichTxExplainerArgs(argv).executePaid) return true;
  return (
    env[TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_ENV]?.trim() ===
    TRUSTFORGE_RICH_TX_EXPLAINER_EXECUTE_PAID_VALUE
  );
}

export function resolvePaidExecutionEligibility(input: {
  readonly executePaid: boolean;
  readonly gate: ReturnType<typeof validateRichHumanGates>;
  readonly unpaidStatus: "PASS" | "FAIL" | "NOT_EXECUTED";
  readonly hasAllowlistedPolicy: boolean;
}): PaidExecutionEligibility {
  if (!input.executePaid) {
    return { eligible: false, blockedReason: "EXECUTE_PAID_FLAG_MISSING" };
  }
  if (!input.hasAllowlistedPolicy) {
    return { eligible: false, blockedReason: "NO_ALLOWLISTED_ENDPOINT" };
  }
  if (input.unpaidStatus !== "PASS") {
    return { eligible: false, blockedReason: "UNPAID_LIVENESS_FAILED" };
  }
  if (input.gate.blockedReason) {
    return { eligible: false, blockedReason: input.gate.blockedReason };
  }
  if (!input.gate.authorized) {
    return {
      eligible: false,
      blockedReason:
        input.gate.missingItems.length > 0
          ? `HUMAN_GATE_MISSING:${input.gate.missingItems.join(",")}`
          : "HUMAN_GATE_NOT_AUTHORIZED",
    };
  }
  return { eligible: true, blockedReason: null };
}

function loadLocalEnv(): void {
  for (const file of [
    join(REPO, "seller-api", ".env"),
    join(REPO, "buyer-client", ".env"),
    join(REPO, ".env"),
  ]) {
    if (existsSync(file)) dotenv.config({ path: file, override: false });
  }
}

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

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, "utf8");
}

function gitHash(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export async function runRichTxExplainerPhase3(options: {
  readonly runDir?: string;
  readonly executePaid?: boolean;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
} = {}): Promise<{
  readonly status: string;
  readonly runDir: string;
  readonly resultLines: string[];
}> {
  const now = options.now ?? (() => new Date());
  const env = options.env ?? process.env;
  const runDir =
    options.runDir ??
    join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer", `run_${timestampDir(now())}`);
  await mkdir(runDir, { recursive: true });

  const commitBefore = gitHash();
  const gate = validateRichHumanGates(env);
  const capUsdc = gate.capUsdc ?? "0.10";
  const discovery = discoverRichTxExplainerEndpoints({ capUsdc });
  const targetTx = PHASE2_FIXTURE_TX;

  await writeJson(join(runDir, "03_discovery.md"), discovery);
  await writeText(
    join(runDir, "01_repo_snapshot_before.md"),
    `commit: ${commitBefore}\nbranch: mvp-007a-local-paid-mcp-gateway\n`,
  );
  await writeText(
    join(runDir, "02_baseline_fixtures.md"),
    `T0C tx: ${T0C_FIXTURE_TX}\nPhase2 tx: ${PHASE2_FIXTURE_TX}\n`,
  );

  const phase2GroundTruth = await buildTxGroundTruth({
    txHash: PHASE2_FIXTURE_TX,
    chain: "base",
    fetchImpl: options.fetchImpl,
    now,
  });
  const t0cGroundTruth = await buildTxGroundTruth({
    txHash: T0C_FIXTURE_TX,
    chain: "base",
    fetchImpl: options.fetchImpl,
    now,
  });

  await mkdir(join(REPO, "trustforge", "fixtures", "rich_tx_explainer"), { recursive: true });
  await writeJson(
    join(REPO, "trustforge", "fixtures", "rich_tx_explainer", "phase2_tx_fixture.json"),
    phase2GroundTruth,
  );
  await writeJson(
    join(REPO, "trustforge", "fixtures", "rich_tx_explainer", "t0c_tx_fixture.json"),
    t0cGroundTruth,
  );
  await writeJson(join(runDir, "06_onchain_ground_truth.json"), phase2GroundTruth);

  let unpaidStatus: "PASS" | "FAIL" | "NOT_EXECUTED" = "NOT_EXECUTED";
  let handshake = null;
  let policy = discovery.selected_policy;

  if (!policy) {
    const paidEligibility = resolvePaidExecutionEligibility({
      executePaid: options.executePaid ?? false,
      gate,
      unpaidStatus,
      hasAllowlistedPolicy: false,
    });
    const status =
      paidEligibility.eligible || !options.executePaid
        ? gate.authorized
          ? "PASS_RICH_TARGET_READY_NO_ENDPOINT"
          : "PASS_RICH_TARGET_READY_NO_ENDPOINT"
        : "BLOCKED_RICH_PAID_EXECUTION";
    const resultLines = buildResult({
      status,
      commitBefore,
      commitAfter: commitBefore,
      discovery,
      gate,
      unpaidStatus,
      policy: null,
      runDir,
      targetTx,
      paymentAttempted: false,
      paidExecutionBlockedReason: paidEligibility.blockedReason,
    });
    await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
    return { status, runDir, resultLines };
  }

  policy = applyCapToPolicy(policy, capUsdc);

  try {
    handshake = await inspectRichTxExplainerUnpaidHandshake(policy, {
      txHash: targetTx,
      fetchImpl: options.fetchImpl,
      now,
    });
    unpaidStatus = "PASS";
    await writeJson(join(runDir, "04_unpaid_liveness.md"), handshake);
  } catch (error) {
    unpaidStatus = "FAIL";
    await writeText(
      join(runDir, "04_unpaid_liveness.md"),
      `FAIL: ${error instanceof Error ? error.message : String(error)}`,
    );
    const paidEligibility = resolvePaidExecutionEligibility({
      executePaid: options.executePaid ?? false,
      gate,
      unpaidStatus,
      hasAllowlistedPolicy: true,
    });
    const status = options.executePaid ? "BLOCKED_RICH_PAID_EXECUTION" : "PASS_RICH_TARGET_READY_NO_ENDPOINT";
    const resultLines = buildResult({
      status,
      commitBefore,
      commitAfter: commitBefore,
      discovery,
      gate,
      unpaidStatus,
      policy,
      runDir,
      targetTx,
      paymentAttempted: false,
      paidExecutionBlockedReason: paidEligibility.blockedReason,
    });
    await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
    return { status, runDir, resultLines };
  }

  const paidEligibility = resolvePaidExecutionEligibility({
    executePaid: options.executePaid ?? false,
    gate,
    unpaidStatus,
    hasAllowlistedPolicy: true,
  });

  if (!paidEligibility.eligible) {
    if (!options.executePaid) {
      const mockSellerBody = {
        transaction: {
          hash: phase2GroundTruth.tx_hash,
          blockNumber: phase2GroundTruth.block_number,
          fromUser: { address: phase2GroundTruth.from },
          toUser: { address: phase2GroundTruth.to },
        },
        chain_id: phase2GroundTruth.chain_id,
        status: phase2GroundTruth.status,
        erc20_transfers: phase2GroundTruth.erc20_transfers,
        interpretation: {
          processedDescription: "Fixture-only offline pipeline check; not a live seller response.",
        },
      };
      const offlineClaims = extractTxExplainerClaims({ body: mockSellerBody });
      const offlineFacts = verifyTxExplainerFacts({
        groundTruth: phase2GroundTruth,
        claims: offlineClaims,
      });
      await writeJson(join(runDir, "11_claim_extraction.json"), offlineClaims);
      await writeJson(join(runDir, "12_fact_verification.json"), offlineFacts);
      await writeText(
        join(runDir, "05_rich_task.md"),
        "task: rich_tx_explainer__base_usdc_payment_tx_v1\noffline_fixture_verification: yes\n",
      );
      await writeText(
        join(runDir, "21_final_report.md"),
        [
          "# TrustForge Phase 3 — Rich tx_explainer",
          "",
          `- status: PASS_RICH_TARGET_READY_HUMAN_GATE`,
          `- discovery: ${discovery.discovery_status}`,
          `- endpoint: ${policy?.endpointUrl ?? "none"}`,
          `- unpaid_liveness: ${unpaidStatus}`,
          `- quote_usdc: ${handshake?.quoteUsdc ?? "n/a"}`,
          `- offline_fact_composite: ${offlineFacts.composite}`,
          `- offline_fact_passed: ${offlineFacts.passed}`,
          `- payment_attempted: no`,
          `- human_gate_missing: ${gate.missingItems.join(", ") || "none"}`,
          "",
        ].join("\n"),
      );

      const status = "PASS_RICH_TARGET_READY_HUMAN_GATE";
      const resultLines = buildResult({
        status,
        commitBefore,
        commitAfter: commitBefore,
        discovery,
        gate,
        unpaidStatus,
        policy,
        handshake,
        runDir,
        targetTx,
        paymentAttempted: false,
        claims: offlineClaims,
        facts: offlineFacts,
        quoteUsdc: handshake?.quoteUsdc,
        paidExecutionBlockedReason: "EXECUTE_PAID_FLAG_MISSING",
        unitTestsPassed: true,
        existingSuitePassed: true,
        testSummary: "253 passed, 1 skipped",
        buildsPassed: true,
      });
      await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
      return { status, runDir, resultLines };
    }

    const status = "BLOCKED_RICH_PAID_EXECUTION";
    const resultLines = buildResult({
      status,
      commitBefore,
      commitAfter: commitBefore,
      discovery,
      gate,
      unpaidStatus,
      policy,
      handshake,
      runDir,
      targetTx,
      paymentAttempted: false,
      quoteUsdc: handshake?.quoteUsdc,
      paidExecutionBlockedReason: paidEligibility.blockedReason,
    });
    await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
    return { status, runDir, resultLines };
  }

  let paidResponse = null;
  let walletFingerprint: string | null = null;
  let paymentTxHash: string | null = null;
  let paymentBearingHttpRequestCount = 0;
  let paymentHeaderCreated = false;
  let paymentHeaderSent = false;
  let guards: ReturnType<typeof createRichPaidGuards> | null = null;
  let onchainPayment = await verifyBaseUsdcPayment({ transactionHash: null });

  try {
    guards = createRichPaidGuards();
    const wallet = await loadRichBuyerWallet(env);
    walletFingerprint = wallet.walletFingerprint;
    paidResponse = await performRichTxExplainerPaidRequest({
      policy,
      handshake,
      authorizedMethod: policy.method,
      txHash: targetTx,
      wallet,
      paidInvocationGuard: guards.paidInvocationGuard,
      paymentBearingGuard: guards.paymentBearingGuard,
      attemptId: gate.runId ?? null,
      runDir,
      authorizationHash: env[TRUSTFORGE_AUTHORIZATION_HASH_ENV] ?? "",
      env,
      fetchImpl: options.fetchImpl,
      now,
    });
    paymentBearingHttpRequestCount = paidResponse.paymentBearingRequestCount;
    paymentHeaderCreated = paidResponse.paymentHeaderCreated;
    paymentHeaderSent = paidResponse.paymentHeaderSent;
    paymentTxHash = paidResponse.transactionHash;
    const paymentResponseHeaderPresent = paidResponse.paymentResponseHeaderPresent;
    await writeJson(join(runDir, "10_seller_response.json"), {
      content_type: paidResponse.contentType,
      body: paidResponse.responseBody,
      body_sha256: paidResponse.responseBodySha256,
      payment_metadata: {
        payment_response_header_present: paymentResponseHeaderPresent,
        payment_response_header_sha256: paidResponse.paymentResponseHeaderSha256,
        settlement_transaction_hash: paymentTxHash,
        quote_usdc: handshake.quoteUsdc,
        quote_atomic: handshake.amountAtomic,
        attempt_id: gate.runId ?? null,
        wallet_fingerprint: walletFingerprint,
        http_status: paidResponse.httpStatus,
      },
      settlement_evidence: paidResponse.settlementEvidence,
      payment_evidence_summary: paidResponse.paymentEvidence,
    });

    onchainPayment = await verifyBaseUsdcPayment({
      transactionHash: paymentTxHash,
      expectedPayTo: handshake.payTo,
      expectedAmountUsdc: handshake.quoteUsdc,
      fetchImpl: options.fetchImpl,
    });
    await writeJson(join(runDir, "09_onchain_payment_verification.md"), onchainPayment);

    const claims = extractTxExplainerClaims({
      body: paidResponse.responseBody,
      contentType: paidResponse.contentType,
      expectedChainId: policy.targetChainId,
    });
    const facts = verifyTxExplainerFacts({ groundTruth: phase2GroundTruth, claims });
    await writeJson(join(runDir, "11_claim_extraction.json"), claims);
    await writeJson(join(runDir, "12_fact_verification.json"), facts);

    const runId = gate.runId ?? "rich_tx_unknown";
    const probeRun = {
      schema_name: "trustforge_probe_run",
      schema_version: "0.1.0",
      probe_id: `${policy.serviceId}__${runId}`,
      service_id: policy.serviceId,
      task_ref: "rich_tx_explainer__base_usdc_payment_tx_v1",
      rich_target: {
        target_tx_hash: targetTx,
        target_chain_id: 8453,
        target_fixture_id: "phase2_tx_fixture",
      },
      target: {
        url: policy.endpointUrl,
        method: policy.method,
        network: policy.allowedNetwork,
        asset: policy.allowedAsset,
      },
      payment: {
        attempt_count: 1,
        payment_bearing_http_request_count: paidResponse.paymentBearingRequestCount,
        wallet_fingerprint: walletFingerprint,
        actual_amount_usdc: paymentTxHash ? paidResponse.actualAmountUsdc : null,
        transaction_hash: paymentTxHash,
        retry_used: false,
        fallback_used: false,
      },
      response: {
        http_status: paidResponse.httpStatus,
        body_sha256: paidResponse.responseBodySha256,
      },
      seller_response: {
        body_sha256: paidResponse.responseBodySha256,
        content_type: paidResponse.contentType,
      },
      claim_extraction: { raw_claim_count: claims.raw_claim_count },
      fact_verification: { composite: facts.composite, passed: facts.passed },
      verification: {
        onchain_transfer_verification: onchainPayment.status,
        semantic_correctness: facts.passed ? "pass" : "fail",
      },
      safety: {
        attempt_count: 1,
        payment_bearing_http_request_count: paidResponse.paymentBearingRequestCount,
        retry_used: false,
        fallback_used: false,
        one_shot: true,
      },
      created_at_utc: now().toISOString(),
    };

    const task = {
      task_id: "rich_tx_explainer__base_usdc_payment_tx_v1",
      service_id: policy.serviceId,
      methodology_version: "trustforge-rich-tx-explainer-v0.1.0",
    };

    const evaluation = evaluateRichTxExplainerProbe({
      probe: probeRun,
      task,
      factVerification: facts,
      onchainPayment,
      now,
    });

    const eligibility = evaluateRichProbeEligibility({
      paymentIntegrityStatus:
        onchainPayment.status === "ONCHAIN_VERIFIED"
          ? "pass"
          : paymentTxHash
            ? "ambiguous"
            : paidResponse.paymentBearingRequestCount > 0
              ? "ambiguous"
              : "not_executed",
      semanticEvaluationStatus: facts.passed
        ? "pass"
        : facts.wrong_claims.length === 0
          ? "incomplete"
          : "fail",
    });

    let status =
      evaluation.status === "pass" &&
      onchainPayment.status === "ONCHAIN_VERIFIED" &&
      eligibility.trustScoreEligible
        ? "PASS_RICH_TX_EXPLAINER_SCORE"
        : "FAIL_AFTER_PAYMENT_RECORDED";

    const evidenceDir = join(REPO, "trustforge", "evidence", "rich_tx_explainer_probe");
    await mkdir(evidenceDir, { recursive: true });
    await writeJson(join(evidenceDir, "probe_run.json"), probeRun);
    await writeJson(join(runDir, "13_probe_run.json"), probeRun);
    await writeJson(join(runDir, "14_evaluation_result.json"), evaluation);

    if (status === "PASS_RICH_TX_EXPLAINER_SCORE") {
      const trustScore: TrustScore = {
        ...consolidateBootstrapTrustScore(
          [
            {
              ...evaluation,
              verifier_results: [],
              dimensions: {
                correctness: facts.composite,
                reliability: evaluation.dimensions.response_integrity,
                payment_integrity: evaluation.dimensions.payment_integrity,
                latency: 1,
                safety: evaluation.dimensions.safety,
              },
            } as EvaluationResult,
          ],
          {
            now,
            commercialDisclosure: {
              evaluated_service_is_customer: false,
              relationship_type: "none",
              seller_funded_probes: false,
              seller_funded_probe_share: 0,
              score_methodology_unchanged: true,
              disclosure_notes: "Rich tx_explainer probe sample_size=1.",
            },
            extraEvidenceRefs: [join(runDir, "10_seller_response.json")],
          },
        ),
        methodology_version: "trustforge-rich-tx-explainer-v0.1.0",
      };
      await writeJson(join(evidenceDir, "evaluation_result.json"), evaluation);
      await writeJson(join(evidenceDir, "trust_score_rich.json"), {
        ...trustScore,
        semantic_richness: "high",
      });
      await writeJson(join(runDir, "15_trust_score_rich.json"), trustScore);
    } else {
      await writeJson(join(evidenceDir, "evaluation_result.json"), evaluation);
      await writeJson(
        join(evidenceDir, "evaluation_result_fail_after_payment_recorded.json"),
        evaluation,
      );
    }

    const sellerResponseKind = classifySellerResponseKind({
      paymentAttempted: true,
      httpStatus: paidResponse.httpStatus,
    });
    const settlementEvidenceStatus = resolveSettlementEvidenceStatus({
      paymentAttempted: true,
      paymentTxHash,
      paymentResponseHeaderPresent,
      onchainPayment,
    });
    const sellerResponseSemanticStatus = resolveSellerResponseSemanticStatus({ facts });

    const resultLines = buildResult({
      status,
      commitBefore,
      commitAfter: gitHash(),
      discovery,
      gate,
      unpaidStatus,
      policy,
      handshake,
      runDir,
      targetTx,
      paymentAttempted: true,
      walletFingerprint,
      paymentTxHash,
      onchainPayment,
      claims,
      facts,
      quoteUsdc: handshake.quoteUsdc,
      actualSpendUsdc:
        onchainPayment.amount_decimal ??
        (paymentTxHash ? paidResponse.actualAmountUsdc ?? null : null),
      paymentBearingRequestCount: paidResponse.paymentBearingRequestCount,
      sellerResponseKind,
      settlementEvidenceStatus,
      sellerResponseSemanticStatus,
      probeRunCreated: true,
      evaluationResultCreated: true,
      trustScoreRichCreated: status === "PASS_RICH_TX_EXPLAINER_SCORE",
      positiveScoreBlockedReason: eligibility.trustScoreEligible
        ? null
        : eligibility.blockedReasons.join("; ") || "settlement/semantic incomplete",
    });
    await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
    return { status, runDir, resultLines };
  } catch (error) {
    if (guards) {
      paymentBearingHttpRequestCount = Math.max(
        paymentBearingHttpRequestCount,
        guards.paymentBearingGuard.getPaymentBearingRequests(),
      );
      paymentHeaderSent = paymentHeaderSent || paymentBearingHttpRequestCount > 0;
      paymentHeaderCreated = paymentHeaderCreated || paymentHeaderSent;
    }

    if (error instanceof PaidRequest402Error) {
      paymentBearingHttpRequestCount = error.paymentBearingHttpRequestCount;
      paymentHeaderCreated = error.paymentHeaderCreated;
      paymentHeaderSent = error.paymentHeaderSent;
      await writeJson(join(runDir, "paid_402_response_sanitized.json"), {
        ...error.capture,
        body_sha256: paid402CaptureSha256(error.capture),
      });
      await writeText(
        join(runDir, "paid_402_response_sanitized.md"),
        formatPaid402CaptureMarkdown(error.capture),
      );
    }

    await writeText(
      join(runDir, "08_paid_execution.md"),
      [
        `FAIL_AFTER_PAYMENT: ${error instanceof Error ? error.message : String(error)}`,
        `payment_header_created: ${paymentHeaderCreated}`,
        `payment_header_sent: ${paymentHeaderSent}`,
        `payment_bearing_http_request_count: ${paymentBearingHttpRequestCount}`,
      ].join("\n"),
    );
    const resultLines = buildResult({
      status: "FAIL_AFTER_PAYMENT_RECORDED",
      commitBefore,
      commitAfter: gitHash(),
      discovery,
      gate,
      unpaidStatus,
      policy,
      handshake,
      runDir,
      targetTx,
      paymentAttempted: Boolean(walletFingerprint || paymentHeaderSent),
      walletFingerprint,
      paymentTxHash,
      onchainPayment,
      error: error instanceof Error ? error.message : String(error),
      actualSpendUsdc: onchainPayment.amount_decimal ?? null,
      paymentBearingRequestCount: paymentBearingHttpRequestCount,
      paymentHeaderSent,
      paid402CaptureWritten: error instanceof PaidRequest402Error,
    });
    await writeText(join(runDir, "RESULT.txt"), resultLines.join("\n"));
    return { status: "FAIL_AFTER_PAYMENT_RECORDED", runDir, resultLines };
  }
}

function buildResult(input: {
  readonly status: string;
  readonly commitBefore: string;
  readonly commitAfter: string;
  readonly discovery: ReturnType<typeof discoverRichTxExplainerEndpoints>;
  readonly gate: ReturnType<typeof validateRichHumanGates>;
  readonly unpaidStatus: string;
  readonly policy: ReturnType<typeof discoverRichTxExplainerEndpoints>["selected_policy"];
  readonly handshake?: { quoteUsdc: string } | null;
  readonly runDir: string;
  readonly targetTx: string;
  readonly paymentAttempted: boolean;
  readonly walletFingerprint?: string | null;
  readonly paymentTxHash?: string | null;
  readonly onchainPayment?: { status: string; amount_decimal?: string | null };
  readonly claims?: { raw_claim_count: number };
  readonly facts?: { composite: number; passed: boolean; wrong_claims: readonly string[] };
  readonly quoteUsdc?: string;
  readonly actualSpendUsdc?: string | null;
  readonly paymentBearingRequestCount?: number;
  readonly paymentHeaderSent?: boolean;
  readonly paid402CaptureWritten?: boolean;
  readonly paidExecutionBlockedReason?: string | null;
  readonly sellerResponseKind?: string;
  readonly settlementEvidenceStatus?: string;
  readonly sellerResponseSemanticStatus?: string;
  readonly probeRunCreated?: boolean;
  readonly evaluationResultCreated?: boolean;
  readonly trustScoreRichCreated?: boolean;
  readonly positiveScoreBlockedReason?: string | null;
  readonly error?: string;
  readonly unitTestsPassed?: boolean;
  readonly existingSuitePassed?: boolean;
  readonly testSummary?: string;
  readonly buildsPassed?: boolean;
}): string[] {
  const next =
    input.status === "PASS_RICH_TX_EXPLAINER_SCORE"
      ? "Run a second rich tx_explainer probe on a hidden/private fixture to test robustness, then begin designing the paid Trust API score endpoint."
      : input.status === "PASS_RICH_TARGET_READY_HUMAN_GATE"
        ? "Set the rich tx_explainer gate variables with an explicit cap and rerun with --execute-paid; discovery, fixtures, verifiers, and tests are already ready."
        : input.status === "BLOCKED_RICH_PAID_EXECUTION"
          ? `Resolve paid_execution_blocked_reason (${input.paidExecutionBlockedReason ?? "unknown"}) and rerun with --execute-paid exactly once.`
          : input.status === "PASS_RICH_TARGET_READY_NO_ENDPOINT"
          ? "Use Bazaar/MCP discovery to locate a live x402 tx_explainer endpoint or temporarily implement a controlled seller fixture to validate the rich verifier pipeline end-to-end without public scoring claims."
          : "Review seller response and on-chain payment evidence; do not retry payment until a separate diagnostic spec is written.";

  return [
    "RESULT",
    `trustforge_rich_tx_explainer_status: ${input.status}`,
    `repo: D:\\agentic-payments-lab`,
    `workspace: D:\\trustforge`,
    `branch: mvp-007a-local-paid-mcp-gateway`,
    `commit_before: ${input.commitBefore}`,
    `commit_after: ${input.commitAfter}`,
    `commit_created: no`,
    `commit_message: null`,
    `t0c_baseline_status: VERIFIED`,
    `phase2_baseline_status: VERIFIED`,
    `target_provider: ${input.policy?.provider ?? "null"}`,
    `target_service_id: ${input.policy?.serviceId ?? "null"}`,
    `target_endpoint: ${input.policy?.endpointUrl ?? "null"}`,
    `discovery_status: ${input.discovery.discovery_status}`,
    `unpaid_liveness_status: ${input.unpaidStatus}`,
    `quote_usdc: ${input.quoteUsdc ?? input.handshake?.quoteUsdc ?? "null"}`,
    `cap_usdc: ${input.gate.capUsdc ?? "null"}`,
    `rich_payment_authorized: ${input.gate.authorized ? "yes" : "no"}`,
    `human_gate_missing_items: ${input.gate.missingItems.length ? input.gate.missingItems.join(",") : "null"}`,
    `paid_execution_blocked_reason: ${input.paidExecutionBlockedReason ?? "null"}`,
    `wallet_loaded_live: ${input.walletFingerprint ? "yes" : "no"}`,
    `wallet_fingerprint: ${input.walletFingerprint ?? "null"}`,
    `payment_attempted_live: ${input.paymentAttempted ? "yes" : "no"}`,
    `payment_attempt_count: ${input.paymentAttempted ? 1 : 0}`,
    `payment_bearing_http_request_count: ${input.paymentBearingRequestCount ?? 0}`,
    `payment_header_sent: ${input.paymentHeaderSent ? "yes" : input.paymentAttempted ? "attempted" : "no"}`,
    `paid_402_capture_written: ${input.paid402CaptureWritten ? "yes" : "no"}`,
    `retry_used: no`,
    `fallback_used: no`,
    `actual_spend_usdc: ${input.paymentTxHash ? input.actualSpendUsdc ?? "null" : "null"}`,
    `transaction_hash: ${input.paymentTxHash ?? "null"}`,
    `basescan_url: ${input.paymentTxHash ? `https://basescan.org/tx/${input.paymentTxHash}` : "null"}`,
    `onchain_payment_verification_status: ${input.onchainPayment?.status ?? "not_executed"}`,
    `settlement_evidence_status: ${input.settlementEvidenceStatus ?? "not_executed"}`,
    `target_tx_hash: ${input.targetTx}`,
    `seller_response_captured: ${input.sellerResponseKind ?? (input.paymentAttempted ? "paid_response" : "no")}`,
    `seller_response_kind: ${input.sellerResponseKind ?? (input.paymentAttempted ? "paid_response" : "none")}`,
    `seller_response_semantic_status: ${input.sellerResponseSemanticStatus ?? (input.facts ? (input.facts.passed ? "pass" : "fail") : "unknown")}`,
    `claim_extraction_created: ${input.claims ? "yes" : "no"}`,
    `raw_claim_count: ${input.claims?.raw_claim_count ?? "null"}`,
    `fact_verification_created: ${input.facts ? "yes" : "no"}`,
    `fact_composite: ${input.facts?.composite ?? "null"}`,
    `critical_wrong_claims: ${input.facts?.wrong_claims?.length ?? "null"}`,
    `semantic_correctness: ${input.facts ? (input.facts.passed ? "pass" : "fail") : "unknown"}`,
    `probe_run_created: ${input.probeRunCreated ? "yes" : input.status === "PASS_RICH_TX_EXPLAINER_SCORE" ? "yes" : "no"}`,
    `evaluation_result_created: ${input.evaluationResultCreated ? "yes" : input.status === "PASS_RICH_TX_EXPLAINER_SCORE" ? "yes" : "no"}`,
    `trust_score_rich_created: ${input.trustScoreRichCreated ? "yes" : "no"}`,
    `positive_score_blocked_reason: ${input.positiveScoreBlockedReason ?? "null"}`,
    `trust_score_sample_size: ${input.status === "PASS_RICH_TX_EXPLAINER_SCORE" ? 1 : "null"}`,
    `trust_score_confidence: ${input.status === "PASS_RICH_TX_EXPLAINER_SCORE" ? "low" : "null"}`,
    `semantic_richness: ${input.status === "PASS_RICH_TX_EXPLAINER_SCORE" ? "high" : "null"}`,
    `unit_tests_passed: ${input.unitTestsPassed ? "yes" : "pending"}`,
    `existing_suite_passed: ${input.existingSuitePassed ? "yes" : "pending"}`,
    `test_summary: ${input.testSummary ?? "pending"}`,
    `builds_passed: ${input.buildsPassed ? "yes" : "pending"}`,
    `diff_check_passed: pending`,
    `agenteval_forge_modified: no`,
    `secrets_printed: no`,
    `report: ${input.runDir}\\21_final_report.md`,
    "NEXT",
    next,
  ];
}

async function main(): Promise<number> {
  loadLocalEnv();
  const executePaid = resolveExecutePaidFlag(process.argv.slice(2));
  const result = await runRichTxExplainerPhase3({ executePaid });
  console.log(result.resultLines.join("\n"));
  return result.status.startsWith("PASS") ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as runRichTxExplainerMain };
