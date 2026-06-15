/**
 * trustforge:contracts:validate — load every TrustForge schema, then validate
 * the bootstrap registry, the ServiceEvalTask, the mock ProbeRun fixture, and a
 * full mock evaluate→score pipeline against their contracts. Deterministic and
 * dependency-free. Exits non-zero on any contract failure.
 */

import { existsSync } from "node:fs";
import {
  CONTRACT_FILES,
  loadAllSchemas,
  readJson,
  repoPath,
  validateAgainst,
  type ContractName,
} from "./trustforge/contracts";
import {
  evaluateBootstrapProbe,
  type EvalTaskLike,
  type ProbeRunLike,
} from "./trustforge/evaluate-bootstrap-probe";
import { consolidateBootstrapTrustScore } from "./trustforge/consolidate-bootstrap-trust-score";

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function check(name: string, fn: () => void): Check {
  try {
    fn();
    return { name, ok: true, detail: "ok" };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function expectValid(name: ContractName, data: unknown): void {
  const errors = validateAgainst(name, data);
  if (errors.length > 0) {
    throw new Error(
      errors.map((e) => `${e.path}: ${e.message}`).slice(0, 6).join("; "),
    );
  }
}

function main(): void {
  const checks: Check[] = [];
  const fixedNow = () => new Date("2026-06-13T03:43:00.000Z");

  checks.push(
    check("schemas_loadable", () => {
      const schemas = loadAllSchemas();
      const count = Object.keys(schemas).length;
      if (count !== Object.keys(CONTRACT_FILES).length) {
        throw new Error(`expected ${Object.keys(CONTRACT_FILES).length} schemas, loaded ${count}`);
      }
    }),
  );

  const registry = readJson(
    repoPath("trustforge", "registry", "services.bootstrap.json"),
  );
  checks.push(check("registry_valid", () => expectValid("service_registry", registry)));

  const task = readJson(
    repoPath("trustforge", "tasks", "onesource_api_chain_id", "ethereum_chain_id_v1.json"),
  );
  checks.push(check("service_eval_task_valid", () => expectValid("service_eval_task", task)));

  const probe = readJson(
    repoPath("trustforge", "fixtures", "probe_run.mock.json"),
  );
  checks.push(check("mock_probe_run_valid", () => expectValid("probe_run", probe)));

  // Mock pipeline: evaluate the mock probe, consolidate, validate both outputs.
  checks.push(
    check("mock_pipeline_evaluate_and_score", () => {
      const evaluation = evaluateBootstrapProbe(
        probe as ProbeRunLike,
        task as EvalTaskLike,
        { now: fixedNow },
      );
      expectValid("evaluation_result", evaluation);
      if (evaluation.status !== "pass" || evaluation.composite !== 1) {
        throw new Error(
          `mock evaluation expected pass/composite=1, got ${evaluation.status}/${evaluation.composite}`,
        );
      }
      const score = consolidateBootstrapTrustScore([evaluation], {
        now: fixedNow,
        extraEvidenceRefs: ["fixture:probe_run.mock.json"],
      });
      expectValid("trust_score", score);
      if (score.sample_size !== 1 || score.confidence !== "low") {
        throw new Error(
          `mock score expected sample_size=1/confidence=low, got ${score.sample_size}/${score.confidence}`,
        );
      }
    }),
  );

  // Phase 4 v1 settlement-first contracts (fixture-backed, offline).
  const settlementFixture = readJson(
    repoPath(
      "trustforge",
      "fixtures",
      "phase4_settlement_replay",
      "settlement_0x9b605b35ed.json",
    ),
  );
  checks.push(
    check("phase4_settlement_fixture_shape", () => {
      const v1 = {
        schema_version: "settlement_evidence.v1",
        status: "pass",
        chain_id: (settlementFixture as { chain_id: number }).chain_id,
        network: "base",
        tx_hash: (settlementFixture as { tx_hash: string }).tx_hash,
        block_number: (settlementFixture as { block_number: number }).block_number,
        payer: (settlementFixture as { payer: string }).payer,
        payee: (settlementFixture as { payee: string }).payee,
        token: (settlementFixture as { token: unknown }).token,
        amount: (settlementFixture as { amount: unknown }).amount,
        settlement_recipient_matches_quote: true,
        settlement_amount_matches_quote: true,
        settlement_chain_matches_quote: true,
        confirmations: 1,
        explorer_url: (settlementFixture as { explorer_url: string }).explorer_url,
        evidence_source: "offline_replay",
        reconciled_at: (settlementFixture as { reconciled_at: string }).reconciled_at,
      };
      expectValid("settlement_evidence_v1", v1);
    }),
  );

  checks.push(
    check("phase4_blocked_trust_score_fixture", () => {
      expectValid("blocked_trust_score_result_v1", {
        schema_version: "blocked_trust_score_result.v1",
        trust_score_created: false,
        blocked_reason: "missing_semantic_evaluation_pass",
        payment_integrity_status: "pass",
        semantic_evaluation_status: "incomplete",
        checked_at: "2026-06-15T00:00:00.000Z",
      });
    }),
  );

  // Real artifacts: present only after a real T0C paid probe has settled on-chain.
  const realScorePath = repoPath(
    "trustforge",
    "runtime",
    "scores",
    "onesource_api_chain_id.json",
  );
  const realScoreExists = existsSync(realScorePath);
  if (realScoreExists) {
    const realScore = readJson(realScorePath) as { sample_size?: number };
    checks.push(
      check("real_trust_score_valid", () => {
        expectValid("trust_score", realScore);
        if (!realScore.sample_size || realScore.sample_size < 1) {
          throw new Error("real trust score must have sample_size >= 1");
        }
      }),
    );
  }

  const allOk = checks.every((c) => c.ok);
  console.log("RESULT:", allOk ? "PASS" : "FAIL");
  console.log(`contracts_dir: ${repoPath("contracts", "trustforge")}`);
  console.log(`schemas_count: ${Object.keys(CONTRACT_FILES).length}`);
  for (const c of checks) {
    console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` -> ${c.detail}`}`);
  }
  console.log(
    realScoreExists
      ? `real_score_created: yes (${realScorePath})`
      : "real_score_created: no (REAL_SCORE_NOT_CREATED — mock fixtures only)",
  );
  if (!allOk) {
    process.exitCode = 1;
  }
}

main();
