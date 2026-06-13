import { describe, expect, it } from "vitest";

import {
  evaluateBootstrapProbe,
  type EvalTaskLike,
  type EvaluationResult,
  type ProbeRunLike,
} from "../../tools/trustforge/evaluate-bootstrap-probe";
import {
  consolidateBootstrapTrustScore,
} from "../../tools/trustforge/consolidate-bootstrap-trust-score";

const fixedNow = () => new Date("2026-06-13T03:43:00.000Z");

const TASK: EvalTaskLike = {
  task_id: "onesource_api_chain_id__ethereum_chain_id_v1",
  service_id: "onesource_api_chain_id",
  max_acceptable_latency_ms: 5000,
  methodology_version: "trustforge-bootstrap-v0.1.0",
  verifiers: [
    { name: "ethereum_chain_id_matches", weight: 0.6, dimension: "correctness" },
    { name: "http_200", weight: 0.1, dimension: "reliability" },
    { name: "settlement_verified", weight: 0.2, dimension: "payment_integrity" },
    { name: "one_shot_safety", weight: 0.1, dimension: "safety" },
  ],
};

function passingProbe(id: string): ProbeRunLike {
  return {
    probe_id: id,
    service_id: "onesource_api_chain_id",
    response: { http_status: 200, latency_ms: 400, observed_chain_id: 1 },
    verification: {
      ground_truth_before: 1,
      ground_truth_after: 1,
      observed_chain_id: 1,
      semantic_correctness: "pass",
      onchain_transfer_verification: "ONCHAIN_VERIFIED",
    },
    safety: {
      attempt_count: 1,
      payment_bearing_http_request_count: 1,
      retry_used: false,
      fallback_used: false,
    },
  };
}

function evalOf(id: string): EvaluationResult {
  return evaluateBootstrapProbe(passingProbe(id), TASK, { now: fixedNow });
}

describe("consolidateBootstrapTrustScore", () => {
  it("produces a first bootstrap score: sample_size 1, confidence low, regression false", () => {
    const score = consolidateBootstrapTrustScore([evalOf("p1")], { now: fixedNow });
    expect(score.sample_size).toBe(1);
    expect(score.confidence).toBe("low");
    expect(score.regression_flag).toBe(false);
    expect(score.composite).toBe(1);
    expect(score.methodology_version).toBe("trustforge-bootstrap-v0.1.0");
  });

  it("includes a commercial disclosure and evidence refs", () => {
    const score = consolidateBootstrapTrustScore([evalOf("p1")], {
      now: fixedNow,
      extraEvidenceRefs: ["fixture:probe_run.mock.json"],
    });
    expect(score.commercial_disclosure.evaluated_service_is_customer).toBe(false);
    expect(score.commercial_disclosure.seller_funded_probes).toBe(false);
    expect(score.commercial_disclosure.disclosure_notes).toContain("Bootstrap");
    expect(score.evidence_refs.length).toBeGreaterThanOrEqual(2);
    expect(score.evidence_refs).toContain("fixture:probe_run.mock.json");
  });

  it("is deterministic for the same evaluations", () => {
    const a = consolidateBootstrapTrustScore([evalOf("p1")], { now: fixedNow });
    const b = consolidateBootstrapTrustScore([evalOf("p1")], { now: fixedNow });
    expect(a).toEqual(b);
  });

  it("raises confidence as sample size grows", () => {
    const five = consolidateBootstrapTrustScore(
      Array.from({ length: 5 }, (_, i) => evalOf(`p${i}`)),
      { now: fixedNow },
    );
    expect(five.confidence).toBe("medium");
    const twenty = consolidateBootstrapTrustScore(
      Array.from({ length: 20 }, (_, i) => evalOf(`p${i}`)),
      { now: fixedNow },
    );
    expect(twenty.confidence).toBe("high");
  });

  it("flags a regression only when composite drops below the prior", () => {
    const failingProbe = passingProbe("pf");
    const failing = evaluateBootstrapProbe(
      { ...failingProbe, verification: { ...failingProbe.verification, onchain_transfer_verification: "ONCHAIN_FAILED" } },
      TASK,
      { now: fixedNow },
    );
    const score = consolidateBootstrapTrustScore([failing], {
      now: fixedNow,
      priorComposite: 1,
    });
    expect(score.regression_flag).toBe(true);
  });

  it("throws on zero evaluations", () => {
    expect(() => consolidateBootstrapTrustScore([], { now: fixedNow })).toThrow();
  });
});
