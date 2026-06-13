/**
 * trustforge:score:bootstrap — consolidate one or more EvaluationResults into a
 * single TrustScore JSON.
 *
 * Usage:
 *   npm run trustforge:score:bootstrap -- --eval <path> [--eval <path> ...] [--out <path>]
 */

import { writeFileSync } from "node:fs";
import { assertValid, readJson } from "./trustforge/contracts";
import {
  consolidateBootstrapTrustScore,
} from "./trustforge/consolidate-bootstrap-trust-score";
import type { EvaluationResult } from "./trustforge/evaluate-bootstrap-probe";

function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) {
      out.push(process.argv[i + 1]);
    }
  }
  return out;
}

function singleArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function main(): void {
  const evalPaths = args("--eval");
  if (evalPaths.length === 0) {
    console.log("RESULT: FAIL");
    console.log("error: at least one --eval <path> is required");
    process.exitCode = 1;
    return;
  }
  const outPath = singleArg("--out");

  const evaluations = evalPaths.map((path) => {
    const evaluation = readJson(path) as EvaluationResult;
    assertValid("evaluation_result", evaluation);
    return evaluation;
  });

  const score = consolidateBootstrapTrustScore(evaluations);
  assertValid("trust_score", score);

  const json = `${JSON.stringify(score, null, 2)}\n`;
  if (outPath) {
    writeFileSync(outPath, json, "utf8");
  }

  console.log("RESULT:", "PASS");
  console.log(`service_id: ${score.service_id}`);
  console.log(`composite: ${score.composite}`);
  console.log(`sample_size: ${score.sample_size}`);
  console.log(`confidence: ${score.confidence}`);
  console.log(`regression_flag: ${score.regression_flag}`);
  console.log(`methodology_version: ${score.methodology_version}`);
  console.log(`evidence_refs: ${score.evidence_refs.length}`);
  if (outPath) {
    console.log(`written: ${outPath}`);
  }
}

main();
