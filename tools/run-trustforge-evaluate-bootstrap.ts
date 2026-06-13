/**
 * trustforge:evaluate:bootstrap — evaluate a ProbeRun against a ServiceEvalTask
 * and emit an EvaluationResult JSON (LLM-free, deterministic).
 *
 * Usage:
 *   npm run trustforge:evaluate:bootstrap -- --probe-run <path> --task <path> [--out <path>]
 */

import { writeFileSync } from "node:fs";
import {
  assertValid,
  readJson,
  repoPath,
} from "./trustforge/contracts";
import {
  evaluateBootstrapProbe,
  type EvalTaskLike,
  type ProbeRunLike,
} from "./trustforge/evaluate-bootstrap-probe";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const probePath =
    arg("--probe-run") ?? repoPath("trustforge", "fixtures", "probe_run.mock.json");
  const taskPath =
    arg("--task") ??
    repoPath("trustforge", "tasks", "onesource_api_chain_id", "ethereum_chain_id_v1.json");
  const outPath = arg("--out");

  const probe = readJson(probePath) as ProbeRunLike;
  const task = readJson(taskPath) as EvalTaskLike;

  assertValid("probe_run", probe);
  assertValid("service_eval_task", task);

  const evaluation = evaluateBootstrapProbe(probe, task);
  assertValid("evaluation_result", evaluation);

  const json = `${JSON.stringify(evaluation, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
  }

  const isMock = String(probe.probe_id).startsWith("mock_");
  console.log("RESULT:", "PASS");
  console.log(`probe_run: ${probePath}`);
  console.log(`task: ${taskPath}`);
  console.log(`evaluation_id: ${evaluation.evaluation_id}`);
  console.log(`status: ${evaluation.status}`);
  console.log(`composite: ${evaluation.composite}`);
  console.log(`correctness: ${evaluation.dimensions.correctness}`);
  console.log(`payment_integrity: ${evaluation.dimensions.payment_integrity}`);
  console.log(`reliability: ${evaluation.dimensions.reliability}`);
  console.log(`safety: ${evaluation.dimensions.safety}`);
  console.log(`latency: ${evaluation.dimensions.latency}`);
  console.log(`source: ${isMock ? "MOCK_FIXTURE (not a real settlement)" : "real_probe_run"}`);
  if (outPath) {
    console.log(`written: ${outPath}`);
  }
}

main();
