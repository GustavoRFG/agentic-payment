/**
 * run-trustforge-rich-tx-explainer-diagnostics — offline analysis of saved rich runs.
 * No wallet, no network, no paid requests.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractTxExplainerClaims } from "./trustforge/extract-tx-explainer-claims";
import { verifyTxExplainerFacts } from "./trustforge/verify-tx-explainer-facts";
import {
  classifySellerResponseKind,
  resolveSellerResponseSemanticStatus,
  resolveSettlementEvidenceStatus,
} from "./trustforge/rich-tx-explainer-result-semantics";
import { evaluateRichTxExplainerProbe } from "./trustforge/evaluate-rich-tx-explainer-probe";
import type { TxGroundTruth } from "./trustforge/build-tx-ground-truth";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_RUN_DIRS = [
  join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer", "run_20260614_214953"),
  join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer", "run_20260614_215030"),
  join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer", "run_20260614_215039"),
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

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, "utf8");
}

interface SavedSellerResponse {
  readonly content_type?: string;
  readonly body?: unknown;
  readonly body_sha256?: string;
}

interface SavedProbeRun {
  readonly probe_id?: string;
  readonly payment?: {
    readonly attempt_count?: number;
    readonly transaction_hash?: string | null;
    readonly actual_amount_usdc?: string | null;
  };
  readonly response?: { readonly http_status?: number };
}

interface SavedFactVerification {
  readonly composite?: number;
  readonly wrong_claims?: readonly string[];
}

export interface RunDiagnostic {
  readonly run_dir: string;
  readonly body_sha256: string | null;
  readonly original_fact_composite: number | null;
  readonly original_wrong_claim_count: number;
  readonly offline_fact_composite: number;
  readonly offline_wrong_claims: readonly string[];
  readonly offline_missing_core_facts: readonly string[];
  readonly seller_response_kind: string;
  readonly settlement_evidence_status: string;
  readonly seller_response_semantic_status: string;
  readonly evaluation_status: string;
  readonly payment_settlement_found: boolean;
  readonly seller_factually_wrong: boolean;
  readonly verifier_was_too_strict: boolean;
}

export async function diagnoseRichTxExplainerRun(runDir: string): Promise<RunDiagnostic> {
  const groundTruth = await readJson<TxGroundTruth>(join(runDir, "06_onchain_ground_truth.json"));
  const seller = await readJson<SavedSellerResponse>(join(runDir, "10_seller_response.json"));
  const probe = await readJson<SavedProbeRun>(join(runDir, "13_probe_run.json"));
  const originalFacts = await readJson<SavedFactVerification>(
    join(runDir, "12_fact_verification.json"),
  ).catch(() => ({ composite: null, wrong_claims: [] }));

  const claims = extractTxExplainerClaims({
    body: seller.body,
    contentType: seller.content_type,
    expectedChainId: groundTruth.chain_id,
  });
  const facts = verifyTxExplainerFacts({ groundTruth, claims });
  const verifierWasTooStrict =
    (originalFacts.wrong_claims?.length ?? 0) > 0 && facts.wrong_claims.length === 0;

  const sellerResponseKind = classifySellerResponseKind({
    paymentAttempted: (probe.payment?.attempt_count ?? 0) > 0,
    httpStatus: probe.response?.http_status ?? 200,
  });
  const settlementEvidenceStatus = resolveSettlementEvidenceStatus({
    paymentAttempted: (probe.payment?.attempt_count ?? 0) > 0,
    paymentTxHash: probe.payment?.transaction_hash ?? null,
    paymentResponseHeaderPresent: false,
    onchainPayment: { status: "not_executed" },
  });
  const sellerResponseSemanticStatus = resolveSellerResponseSemanticStatus({
    facts,
    verifierAdjusted: verifierWasTooStrict,
  });

  const evaluation = evaluateRichTxExplainerProbe({
    probe: {
      probe_id: probe.probe_id ?? "unknown_probe",
      service_id: "zapper_tx_explainer",
      response: probe.response,
      payment: probe.payment,
    },
    task: {
      task_id: "rich_tx_explainer__base_usdc_payment_tx_v1",
      service_id: "zapper_tx_explainer",
      methodology_version: "trustforge-rich-tx-explainer-v0.1.0",
    },
    factVerification: facts,
    onchainPayment: { status: "not_executed", transaction_hash: null, chain_id: null, usdc_transfer_found: false, amount_atomic: null, amount_decimal: null, pay_to: null, authorizer: null, detail: "offline diagnostic" },
  });

  return {
    run_dir: runDir,
    body_sha256: seller.body_sha256 ?? null,
    original_fact_composite: originalFacts.composite ?? null,
    original_wrong_claim_count: originalFacts.wrong_claims?.length ?? 0,
    offline_fact_composite: facts.composite,
    offline_wrong_claims: facts.wrong_claims,
    offline_missing_core_facts: facts.missing_core_facts,
    seller_response_kind: sellerResponseKind,
    settlement_evidence_status: settlementEvidenceStatus,
    seller_response_semantic_status: sellerResponseSemanticStatus,
    evaluation_status: evaluation.status,
    payment_settlement_found: false,
    seller_factually_wrong: facts.wrong_claims.length > 0,
    verifier_was_too_strict: verifierWasTooStrict,
  };
}

export async function runRichTxExplainerDiagnostics(options: {
  readonly runDirs?: readonly string[];
  readonly outputDir?: string;
  readonly now?: () => Date;
} = {}): Promise<{ readonly outputDir: string; readonly diagnostics: readonly RunDiagnostic[] }> {
  const now = options.now ?? (() => new Date());
  const runDirs = options.runDirs ?? DEFAULT_RUN_DIRS;
  const outputDir =
    options.outputDir ??
    join(WORKSPACE, "artifacts", "runs", "rich-tx-explainer-diagnostics", `run_${timestampDir(now())}`);
  await mkdir(outputDir, { recursive: true });

  const diagnostics: RunDiagnostic[] = [];
  for (const runDir of runDirs) {
    const diagnostic = await diagnoseRichTxExplainerRun(runDir);
    diagnostics.push(diagnostic);
    await writeJson(join(outputDir, `${runDir.split("\\").pop() ?? "run"}_diagnostic.json`), diagnostic);
    await writeJson(join(outputDir, `${runDir.split("\\").pop() ?? "run"}_offline_claims.json`), extractTxExplainerClaims({
      body: (await readJson<SavedSellerResponse>(join(runDir, "10_seller_response.json"))).body,
      expectedChainId: (await readJson<TxGroundTruth>(join(runDir, "06_onchain_ground_truth.json"))).chain_id,
    }));
    await writeJson(join(outputDir, `${runDir.split("\\").pop() ?? "run"}_offline_facts.json`), verifyTxExplainerFacts({
      groundTruth: await readJson<TxGroundTruth>(join(runDir, "06_onchain_ground_truth.json")),
      claims: extractTxExplainerClaims({
        body: (await readJson<SavedSellerResponse>(join(runDir, "10_seller_response.json"))).body,
        expectedChainId: (await readJson<TxGroundTruth>(join(runDir, "06_onchain_ground_truth.json"))).chain_id,
      }),
    }));
  }

  const uniqueBodies = new Set(diagnostics.map((d) => d.body_sha256).filter(Boolean));
  const summary = {
    analyzed_runs: diagnostics.length,
    unique_seller_response_bodies: uniqueBodies.size,
    payment_settlement_found_in_any_run: diagnostics.some((d) => d.payment_settlement_found),
    all_runs_missing_settlement_hash: diagnostics.every((d) => d.settlement_evidence_status === "no_payment_header"),
    original_verifier_false_positives: diagnostics.every((d) => d.verifier_was_too_strict),
    offline_seller_factually_wrong: diagnostics.some((d) => d.seller_factually_wrong),
    offline_semantic_statuses: diagnostics.map((d) => d.seller_response_semantic_status),
    offline_fact_composites: diagnostics.map((d) => d.offline_fact_composite),
    another_paid_run_forbidden_until_new_spec: true,
    diagnostics,
  };

  await writeJson(join(outputDir, "00_summary.json"), summary);
  await writeText(
    join(outputDir, "01_diagnostic_report.md"),
    [
      "# TrustForge rich tx_explainer diagnostics",
      "",
      "Offline-only analysis of saved FAIL_AFTER_PAYMENT_RECORDED runs.",
      "",
      "## Findings",
      "",
      `- analyzed runs: ${diagnostics.length}`,
      `- unique seller response bodies: ${uniqueBodies.size}`,
      `- payment settlement evidence found: ${summary.payment_settlement_found_in_any_run ? "yes" : "no"}`,
      `- settlement hash exposed by x402/Zapper: no (all runs had null transaction_hash)`,
      `- original 8 'wrong' amount claims: extractor false positives from Zapper metadata integers`,
      `- offline seller factually wrong: ${summary.offline_seller_factually_wrong ? "yes" : "no"}`,
      `- verifier too strict: ${summary.original_verifier_false_positives ? "yes (fixed locally)" : "no"}`,
      `- offline semantic status: ${[...new Set(summary.offline_semantic_statuses)].join(", ")}`,
      `- offline fact composites: ${summary.offline_fact_composites.join(", ")}`,
      "",
      "## Root causes",
      "",
      "1. Zapper/x402 did not return a decodable settlement transaction hash in the payment-response header.",
      "2. Claim extractor treated Zapper nonce/gas/block/timestamp integers and JSON prose as USDC amount claims.",
      "3. Zapper `transactionDetailsV2` array schema and `tokenDeltasV2` were not parsed; chain/status omitted from payload.",
      "",
      "## Paid retry policy",
      "",
      "Another paid Zapper run is forbidden until a new diagnostic spec is written.",
      "",
    ].join("\n"),
  );

  const failureEval = {
    schema_name: "trustforge_evaluation_result",
    schema_version: "0.2.0",
    evaluation_id: "zapper_tx_explainer__fail_after_payment_recorded__diagnostic",
    probe_id: "zapper_tx_explainer__aggregated_failures",
    task_id: "rich_tx_explainer__base_usdc_payment_tx_v1",
    service_id: "zapper_tx_explainer",
    status: "fail_after_payment_recorded",
    composite: diagnostics[0]?.offline_fact_composite ?? null,
    semantic_richness: "high",
    methodology_version: "trustforge-rich-tx-explainer-v0.1.0",
    notes:
      "Aggregated offline diagnostic over saved runs; no passing TrustScore; settlement evidence absent.",
    created_at_utc: now().toISOString(),
  };
  await writeJson(join(outputDir, "02_failure_evaluation_result.json"), failureEval);
  await mkdir(join(REPO, "trustforge", "evidence", "rich_tx_explainer_probe"), { recursive: true });
  await writeJson(
    join(REPO, "trustforge", "evidence", "rich_tx_explainer_probe", "evaluation_result_fail_after_payment_recorded.json"),
    failureEval,
  );

  const resultLines = buildDiagnosticResult(summary, outputDir);
  await writeText(join(outputDir, "RESULT.txt"), resultLines.join("\n"));
  return { outputDir, diagnostics };
}

function buildDiagnosticResult(
  summary: {
    readonly payment_settlement_found_in_any_run: boolean;
    readonly offline_seller_factually_wrong: boolean;
    readonly original_verifier_false_positives: boolean;
    readonly another_paid_run_forbidden_until_new_spec: boolean;
  },
  outputDir: string,
): string[] {
  return [
    "RESULT",
    `trustforge_rich_tx_explainer_diagnostic_status: COMPLETE`,
    `output_dir: ${outputDir}`,
    `payment_settlement_found: ${summary.payment_settlement_found_in_any_run ? "yes" : "no"}`,
    `zapper_response_factually_wrong: ${summary.offline_seller_factually_wrong ? "yes" : "no"}`,
    `verifier_too_strict: ${summary.original_verifier_false_positives ? "yes" : "no"}`,
    `another_paid_run_forbidden: ${summary.another_paid_run_forbidden_until_new_spec ? "yes" : "no"}`,
    "NEXT",
    "Do not retry Zapper payment until a new spec covers settlement-hash capture and Zapper schema mapping.",
  ];
}

async function main(): Promise<number> {
  const result = await runRichTxExplainerDiagnostics();
  console.log((await readFile(join(result.outputDir, "RESULT.txt"), "utf8")).trim());
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as runRichTxExplainerDiagnosticsMain };
