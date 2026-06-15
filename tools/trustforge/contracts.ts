/**
 * contracts — loader and validator entry point for the TrustForge JSON Schema
 * contracts. Resolves paths relative to this module so it behaves identically
 * under root `vitest` and under `npm --prefix seller-api exec -- tsx`.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSchemaShape,
  validate,
  type JsonSchema,
  type ValidationError,
} from "./json-schema-lite";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(MODULE_DIR, "..", "..");
export const CONTRACTS_DIR = join(REPO_ROOT, "contracts", "trustforge");

export type ContractName =
  | "probe_run"
  | "service_eval_task"
  | "evaluation_result"
  | "trust_score"
  | "service_registry"
  | "settlement_evidence_v1"
  | "payment_attempt_ledger_entry_v1"
  | "payment_integrity_result_v1"
  | "blocked_trust_score_result_v1";

export const CONTRACT_FILES: Record<ContractName, string> = {
  probe_run: "probe_run.schema.json",
  service_eval_task: "service_eval_task.schema.json",
  evaluation_result: "evaluation_result.schema.json",
  trust_score: "trust_score.schema.json",
  service_registry: "service_registry.schema.json",
  settlement_evidence_v1: "settlement_evidence.v1.schema.json",
  payment_attempt_ledger_entry_v1: "payment_attempt_ledger_entry.v1.schema.json",
  payment_integrity_result_v1: "payment_integrity_result.v1.schema.json",
  blocked_trust_score_result_v1: "blocked_trust_score_result.v1.schema.json",
};

export function repoPath(...parts: string[]): string {
  return join(REPO_ROOT, ...parts);
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadSchema(name: ContractName): JsonSchema {
  const path = join(CONTRACTS_DIR, CONTRACT_FILES[name]);
  const schema = readJson(path);
  return assertSchemaShape(schema, name);
}

export function loadAllSchemas(): Record<ContractName, JsonSchema> {
  const out = {} as Record<ContractName, JsonSchema>;
  for (const name of Object.keys(CONTRACT_FILES) as ContractName[]) {
    out[name] = loadSchema(name);
  }
  return out;
}

export function validateAgainst(
  name: ContractName,
  data: unknown,
): ValidationError[] {
  const schema = loadSchema(name);
  return validate(schema, data, schema);
}

export function assertValid(name: ContractName, data: unknown): void {
  const errors = validateAgainst(name, data);
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  - ${e.path}: ${e.message}`)
      .join("\n");
    throw new Error(`${name} failed contract validation:\n${detail}`);
  }
}
