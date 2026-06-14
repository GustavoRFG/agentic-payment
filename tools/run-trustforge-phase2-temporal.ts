/**
 * trustforge phase2 temporal — evaluate the second deterministic ProbeRun,
 * consolidate its TrustScore, append per-service score history, build a
 * cross-service portfolio roll-up, and report regression/consistency.
 *
 * Deterministic and LLM-free. Writes evidence + runtime artifacts. No payment.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertValid, readJson, repoPath } from "./trustforge/contracts";
import {
  evaluateBootstrapProbe,
  type EvalTaskLike,
  type ProbeRunLike,
} from "./trustforge/evaluate-bootstrap-probe";
import {
  consolidateBootstrapTrustScore,
} from "./trustforge/consolidate-bootstrap-trust-score";
import type { TrustScore } from "./trustforge/consolidate-bootstrap-trust-score";
import {
  appendScoreHistory,
  buildPortfolioTrustScore,
  detectHistoryConsistency,
  type ScoreHistory,
} from "./trustforge/temporal-score-history";

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readHistory(path: string): ScoreHistory | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ScoreHistory;
}

function main(): void {
  const evidenceDir = repoPath("trustforge", "evidence", "phase2_second_deterministic_probe");
  const probePath = join(evidenceDir, "probe_run.json");
  const taskPath = repoPath(
    "trustforge",
    "tasks",
    "onesource_api_block_number",
    "ethereum_block_number_v1.json",
  );

  const probe = readJson(probePath) as ProbeRunLike;
  const task = readJson(taskPath) as EvalTaskLike;
  assertValid("probe_run", probe);
  assertValid("service_eval_task", task);

  // 1. Evaluate.
  const evaluation = evaluateBootstrapProbe(probe, task);
  assertValid("evaluation_result", evaluation);
  writeJson(join(evidenceDir, "evaluation_result.json"), evaluation);
  writeJson(
    repoPath("trustforge", "runtime", "evaluations", `${evaluation.evaluation_id}.json`),
    evaluation,
  );

  // 2. Consolidate the per-service (block-number) TrustScore.
  const blockScore = consolidateBootstrapTrustScore([evaluation], {
    commercialDisclosure: {
      evaluated_service_is_customer: false,
      relationship_type: "none",
      seller_funded_probes: false,
      seller_funded_probe_share: 0,
      score_methodology_unchanged: true,
      disclosure_notes: "Second deterministic external paid probe (block-number).",
    },
  });
  assertValid("trust_score", blockScore);
  writeJson(join(evidenceDir, "trust_score_temporal.json"), blockScore);
  writeJson(repoPath("trustforge", "runtime", "scores", "onesource_api_block_number.json"), blockScore);

  // 3. Append per-service history (block-number).
  const blockHistoryPath = repoPath(
    "trustforge",
    "runtime",
    "scores",
    "onesource_api_block_number",
    "history.json",
  );
  const blockHistory = appendScoreHistory(readHistory(blockHistoryPath), blockScore);
  writeJson(blockHistoryPath, blockHistory);
  const blockConsistency = detectHistoryConsistency(blockHistory);

  // 4. Load the T0C chain-id TrustScore and append its history (baseline carry-over).
  const chainScore = readJson(
    repoPath("trustforge", "evidence", "t0c_first_paid_probe", "trust_score.json"),
  ) as TrustScore;
  assertValid("trust_score", chainScore);
  const chainHistoryPath = repoPath(
    "trustforge",
    "runtime",
    "scores",
    "onesource_api_chain_id",
    "history.json",
  );
  const chainHistory = appendScoreHistory(readHistory(chainHistoryPath), chainScore);
  writeJson(chainHistoryPath, chainHistory);

  // 5. Cross-service portfolio roll-up.
  const portfolio = buildPortfolioTrustScore([chainScore, blockScore]);
  writeJson(repoPath("trustforge", "runtime", "scores", "portfolio_trust_score.json"), portfolio);
  writeJson(join(evidenceDir, "portfolio_trust_score.json"), portfolio);

  console.log("RESULT: PASS");
  console.log(`evaluation_id: ${evaluation.evaluation_id}`);
  console.log(`evaluation_status: ${evaluation.status}`);
  console.log(`block_number_composite: ${blockScore.composite}`);
  console.log(`block_number_sample_size: ${blockScore.sample_size}`);
  console.log(`block_number_confidence: ${blockScore.confidence}`);
  console.log(`block_number_regression_flag: ${blockScore.regression_flag}`);
  console.log(`block_number_consistency: ${blockConsistency.consistency}`);
  console.log(`portfolio_services: ${portfolio.service_count}`);
  console.log(`portfolio_total_sample_size: ${portfolio.total_sample_size}`);
  console.log(`portfolio_composite: ${portfolio.composite}`);
  console.log(`portfolio_regression_flag: ${portfolio.regression_flag}`);
}

main();
