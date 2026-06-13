import { describe, expect, it } from "vitest";

import {
  evaluateBootstrapProbe,
  type EvalTaskLike,
  type ProbeRunLike,
} from "../../tools/trustforge/evaluate-bootstrap-probe";

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

function probe(overrides: Partial<ProbeRunLike> = {}): ProbeRunLike {
  const base: ProbeRunLike = {
    probe_id: "mock_probe_0001",
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
  return {
    ...base,
    ...overrides,
    response: { ...base.response, ...overrides.response },
    verification: { ...base.verification, ...overrides.verification },
    safety: { ...base.safety, ...overrides.safety },
  };
}

describe("evaluateBootstrapProbe", () => {
  it("passes a complete probe with composite 1", () => {
    const r = evaluateBootstrapProbe(probe(), TASK, { now: fixedNow });
    expect(r.status).toBe("pass");
    expect(r.composite).toBe(1);
    expect(r.dimensions).toMatchObject({
      correctness: 1,
      reliability: 1,
      payment_integrity: 1,
      safety: 1,
    });
    expect(r.dimensions.latency).toBe(1);
  });

  it("fails correctness when ground truth after disagrees", () => {
    const r = evaluateBootstrapProbe(
      probe({ verification: { ground_truth_after: 137 } }),
      TASK,
      { now: fixedNow },
    );
    expect(r.dimensions.correctness).toBe(0);
    expect(r.composite).toBe(0.4);
    expect(r.status).toBe("fail");
  });

  it("fails settlement when on-chain transfer is not verified", () => {
    const r = evaluateBootstrapProbe(
      probe({ verification: { onchain_transfer_verification: "ONCHAIN_FAILED" } }),
      TASK,
      { now: fixedNow },
    );
    expect(r.dimensions.payment_integrity).toBe(0);
    expect(r.composite).toBe(0.8);
    expect(r.status).toBe("fail");
  });

  it("fails one-shot safety when more than one payment attempt is recorded", () => {
    const r = evaluateBootstrapProbe(
      probe({ safety: { attempt_count: 2 } }),
      TASK,
      { now: fixedNow },
    );
    expect(r.dimensions.safety).toBe(0);
    expect(r.composite).toBe(0.9);
    expect(r.status).toBe("fail");
  });

  it("scales latency inversely with observed latency", () => {
    const slow = evaluateBootstrapProbe(
      probe({ response: { latency_ms: 10000 } }),
      TASK,
      { now: fixedNow },
    );
    expect(slow.dimensions.latency).toBe(0.5);
    const fast = evaluateBootstrapProbe(
      probe({ response: { latency_ms: 100 } }),
      TASK,
      { now: fixedNow },
    );
    expect(fast.dimensions.latency).toBe(1);
  });

  it("is deterministic for the same input", () => {
    const a = evaluateBootstrapProbe(probe(), TASK, { now: fixedNow });
    const b = evaluateBootstrapProbe(probe(), TASK, { now: fixedNow });
    expect(a).toEqual(b);
  });

  it("rejects a probe whose service_id does not match the task", () => {
    expect(() =>
      evaluateBootstrapProbe(probe({ service_id: "other" }), TASK, { now: fixedNow }),
    ).toThrow("service_id mismatch");
  });
});
