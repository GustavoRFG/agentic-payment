import { describe, expect, it } from "vitest";

import {
  loadAllSchemas,
  loadSchema,
  readJson,
  repoPath,
  validateAgainst,
} from "../../tools/trustforge/contracts";
import {
  isValid,
  validate,
} from "../../tools/trustforge/json-schema-lite";
import {
  evaluateBootstrapProbe,
  type EvalTaskLike,
  type ProbeRunLike,
} from "../../tools/trustforge/evaluate-bootstrap-probe";
import { consolidateBootstrapTrustScore } from "../../tools/trustforge/consolidate-bootstrap-trust-score";

const fixedNow = () => new Date("2026-06-13T03:43:00.000Z");

describe("TrustForge contracts — schema loading", () => {
  it("loads all five schemas with a $schema declaration", () => {
    const schemas = loadAllSchemas();
    expect(Object.keys(schemas)).toHaveLength(5);
    for (const schema of Object.values(schemas)) {
      expect(typeof schema.$schema).toBe("string");
    }
  });
});

describe("TrustForge contracts — fixtures validate", () => {
  it("validates the bootstrap registry", () => {
    const registry = readJson(
      repoPath("trustforge", "registry", "services.bootstrap.json"),
    );
    expect(validateAgainst("service_registry", registry)).toEqual([]);
  });

  it("validates the ServiceEvalTask", () => {
    const task = readJson(
      repoPath("trustforge", "tasks", "onesource_api_chain_id", "ethereum_chain_id_v1.json"),
    );
    expect(validateAgainst("service_eval_task", task)).toEqual([]);
  });

  it("validates the mock ProbeRun", () => {
    const probe = readJson(
      repoPath("trustforge", "fixtures", "probe_run.mock.json"),
    );
    expect(validateAgainst("probe_run", probe)).toEqual([]);
  });

  it("validates evaluation and score derived from the mock probe", () => {
    const probe = readJson(
      repoPath("trustforge", "fixtures", "probe_run.mock.json"),
    ) as ProbeRunLike;
    const task = readJson(
      repoPath("trustforge", "tasks", "onesource_api_chain_id", "ethereum_chain_id_v1.json"),
    ) as EvalTaskLike;
    const evaluation = evaluateBootstrapProbe(probe, task, { now: fixedNow });
    expect(validateAgainst("evaluation_result", evaluation)).toEqual([]);
    const score = consolidateBootstrapTrustScore([evaluation], { now: fixedNow });
    expect(validateAgainst("trust_score", score)).toEqual([]);
  });
});

describe("TrustForge contracts — invalid data is rejected", () => {
  it("rejects a registry service missing service_id", () => {
    const bad = {
      schema_name: "trustforge_service_registry",
      registry_version: "0.1.0",
      services: [
        {
          provider: "OneSource",
          category: "chain_metadata",
          endpoint_url: "https://api.onesource.io/x",
          method: "GET",
          network: "eip155:8453",
          asset: "USDC",
          last_observed_quote_usdc: "0.001",
          ground_truth_strategy: "x",
          status: "proven_unpaid_handshake",
          evidence_refs: ["x"],
        },
      ],
    };
    expect(validateAgainst("service_registry", bad).length).toBeGreaterThan(0);
  });

  it("rejects a trust_score with an unknown confidence", () => {
    const score = readJson(
      repoPath("trustforge", "fixtures", "trust_score.mock.json"),
    ) as Record<string, unknown>;
    const bad = { ...score, confidence: "ultra" };
    expect(validateAgainst("trust_score", bad).length).toBeGreaterThan(0);
  });

  it("rejects a probe_run with a non-GET method", () => {
    const probe = readJson(
      repoPath("trustforge", "fixtures", "probe_run.mock.json"),
    ) as Record<string, any>;
    const bad = { ...probe, target: { ...probe.target, method: "POST" } };
    expect(validateAgainst("probe_run", bad).length).toBeGreaterThan(0);
  });
});

describe("json-schema-lite primitives", () => {
  const schema = loadSchema("evaluation_result");

  it("enforces const", () => {
    expect(isValid({ const: "x" }, "x")).toBe(true);
    expect(isValid({ const: "x" }, "y")).toBe(false);
  });

  it("enforces enum and pattern", () => {
    expect(isValid({ enum: ["a", "b"] }, "b")).toBe(true);
    expect(isValid({ enum: ["a", "b"] }, "c")).toBe(false);
    expect(isValid({ type: "string", pattern: "^\\d+$" }, "12")).toBe(true);
    expect(isValid({ type: "string", pattern: "^\\d+$" }, "x")).toBe(false);
  });

  it("enforces additionalProperties:false", () => {
    const s = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    expect(isValid(s, { a: "x" })).toBe(true);
    expect(isValid(s, { a: "x", b: 1 })).toBe(false);
  });

  it("reports a path for a nested failure", () => {
    const errors = validate(schema, { schema_name: "wrong" }, schema);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].path.startsWith("$")).toBe(true);
  });
});
