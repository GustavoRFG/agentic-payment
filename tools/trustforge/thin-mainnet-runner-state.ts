/**
 * thin-mainnet-runner-state — durable state machine for B.4 thin runner.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B4_RUNNER_STATE_INVALID,
  BLOCKED_B4_RUNNER_TERMINAL,
  GUARD_THIN_RUNNER_CANNOT_RETRY_SEND,
} from "./b4-execution-gates";

export const THIN_MAINNET_RUNNER_STATE_ARTIFACT =
  "thin_mainnet_runner_state.json" as const;

export type ThinMainnetRunnerState =
  | "RUN_CREATED"
  | "CANDIDATE_READY"
  | "HUMAN_DECISION_PENDING"
  | "HUMAN_APPROVED"
  | "HUMAN_REJECTED"
  | "FRESH_REQUIREMENTS_VALIDATED"
  | "ATTEMPT_RESERVED"
  | "UNSIGNED_PERSISTED"
  | "SIGNING_AUTH_DERIVED"
  | "CREDENTIAL_AUTH_DERIVED"
  | "SIGNED_PERSISTED"
  | "POST_SIGN_AUDIT_PASS"
  | "PAYMENT_SEND_AUTH_DERIVED"
  | "SEND_COMMITTED_NO_RETRY"
  | "REQUEST_INVOKED"
  | "RESPONSE_OBSERVED"
  | "RECONCILED"
  | "CONFIRMED"
  | "REQUIREMENTS_CHANGED"
  | "SIGNING_EXPIRED"
  | "SIGNING_FAILED"
  | "POST_SIGN_AUDIT_FAILED"
  | "PRE_SEND_VALIDATION_FAILED"
  | "SEND_AMBIGUOUS_RECONCILE"
  | "PAYMENT_FAILED_TERMINAL";

const TERMINAL: ReadonlySet<ThinMainnetRunnerState> = new Set([
  "HUMAN_REJECTED",
  "REQUIREMENTS_CHANGED",
  "SIGNING_EXPIRED",
  "SIGNING_FAILED",
  "POST_SIGN_AUDIT_FAILED",
  "PRE_SEND_VALIDATION_FAILED",
  "SEND_AMBIGUOUS_RECONCILE",
  "PAYMENT_FAILED_TERMINAL",
  "CONFIRMED",
]);

const LEGAL: Readonly<Record<ThinMainnetRunnerState, readonly ThinMainnetRunnerState[]>> = {
  RUN_CREATED: ["CANDIDATE_READY"],
  CANDIDATE_READY: ["HUMAN_DECISION_PENDING"],
  HUMAN_DECISION_PENDING: ["HUMAN_APPROVED", "HUMAN_REJECTED"],
  HUMAN_APPROVED: ["FRESH_REQUIREMENTS_VALIDATED", "REQUIREMENTS_CHANGED"],
  HUMAN_REJECTED: [],
  FRESH_REQUIREMENTS_VALIDATED: ["ATTEMPT_RESERVED", "REQUIREMENTS_CHANGED"],
  ATTEMPT_RESERVED: ["UNSIGNED_PERSISTED", "SIGNING_FAILED"],
  UNSIGNED_PERSISTED: ["SIGNING_AUTH_DERIVED", "SIGNING_FAILED"],
  SIGNING_AUTH_DERIVED: ["CREDENTIAL_AUTH_DERIVED", "SIGNING_FAILED"],
  CREDENTIAL_AUTH_DERIVED: ["SIGNED_PERSISTED", "SIGNING_EXPIRED", "SIGNING_FAILED"],
  SIGNED_PERSISTED: ["POST_SIGN_AUDIT_PASS", "POST_SIGN_AUDIT_FAILED"],
  POST_SIGN_AUDIT_PASS: ["PAYMENT_SEND_AUTH_DERIVED", "PRE_SEND_VALIDATION_FAILED"],
  PAYMENT_SEND_AUTH_DERIVED: ["SEND_COMMITTED_NO_RETRY", "PRE_SEND_VALIDATION_FAILED"],
  SEND_COMMITTED_NO_RETRY: ["REQUEST_INVOKED", "SEND_AMBIGUOUS_RECONCILE"],
  REQUEST_INVOKED: ["RESPONSE_OBSERVED", "SEND_AMBIGUOUS_RECONCILE"],
  RESPONSE_OBSERVED: ["RECONCILED", "SEND_AMBIGUOUS_RECONCILE", "CONFIRMED"],
  RECONCILED: ["CONFIRMED", "SEND_AMBIGUOUS_RECONCILE"],
  CONFIRMED: [],
  REQUIREMENTS_CHANGED: [],
  SIGNING_EXPIRED: [],
  SIGNING_FAILED: [],
  POST_SIGN_AUDIT_FAILED: [],
  PRE_SEND_VALIDATION_FAILED: [],
  SEND_AMBIGUOUS_RECONCILE: [],
  PAYMENT_FAILED_TERMINAL: [],
};

export interface ThinMainnetRunnerStateRecord {
  readonly schema_version: "trustforge_thin_mainnet_runner_state.v1";
  readonly run_id: string;
  readonly state: ThinMainnetRunnerState;
  readonly updated_at: string;
  readonly attempt_id: string | null;
  readonly human_decision_id: string | null;
  readonly payment_send_authorization_sha256: string | null;
  readonly notes: string | null;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function isTerminalRunnerState(state: ThinMainnetRunnerState): boolean {
  return TERMINAL.has(state);
}

export function createRunnerState(runId: string, now: Date): ThinMainnetRunnerStateRecord {
  return {
    schema_version: "trustforge_thin_mainnet_runner_state.v1",
    run_id: runId,
    state: "RUN_CREATED",
    updated_at: now.toISOString(),
    attempt_id: null,
    human_decision_id: null,
    payment_send_authorization_sha256: null,
    notes: null,
  };
}

export function transitionRunnerState(
  record: ThinMainnetRunnerStateRecord,
  to: ThinMainnetRunnerState,
  now: Date,
  patch?: Partial<
    Pick<
      ThinMainnetRunnerStateRecord,
      "attempt_id" | "human_decision_id" | "payment_send_authorization_sha256" | "notes"
    >
  >,
): ThinMainnetRunnerStateRecord {
  if (isTerminalRunnerState(record.state)) {
    fail(BLOCKED_B4_RUNNER_TERMINAL, `cannot leave terminal state ${record.state}`);
  }
  if (!LEGAL[record.state].includes(to)) {
    fail(BLOCKED_B4_RUNNER_STATE_INVALID, `illegal ${record.state} → ${to}`);
  }
  if (record.state === "SEND_COMMITTED_NO_RETRY" && to === "SEND_COMMITTED_NO_RETRY") {
    fail(GUARD_THIN_RUNNER_CANNOT_RETRY_SEND, "send already committed");
  }
  return {
    ...record,
    ...patch,
    state: to,
    updated_at: now.toISOString(),
  };
}

export function persistRunnerState(directory: string, record: ThinMainnetRunnerStateRecord): void {
  writeFileSync(
    join(directory, THIN_MAINNET_RUNNER_STATE_ARTIFACT),
    JSON.stringify(record, null, 2) + "\n",
  );
}

export function loadRunnerState(directory: string): ThinMainnetRunnerStateRecord | null {
  const path = join(directory, THIN_MAINNET_RUNNER_STATE_ARTIFACT);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ThinMainnetRunnerStateRecord;
}

export function evaluateRunnerCrashRecovery(input: {
  readonly record: ThinMainnetRunnerStateRecord | null;
}): {
  readonly disposition:
    | "CLEAN_CONTINUE"
    | "TERMINAL"
    | "AMBIGUOUS_RECONCILE_ONLY"
    | "RESUME_NOT_ALLOWED";
  readonly may_retry_send: false;
  readonly may_resign: false;
  readonly reason: string;
} {
  if (!input.record) {
    return {
      disposition: "CLEAN_CONTINUE",
      may_retry_send: false,
      may_resign: false,
      reason: "no runner state",
    };
  }
  const s = input.record.state;
  if (isTerminalRunnerState(s)) {
    return {
      disposition: s === "SEND_AMBIGUOUS_RECONCILE" ? "AMBIGUOUS_RECONCILE_ONLY" : "TERMINAL",
      may_retry_send: false,
      may_resign: false,
      reason: `terminal ${s}`,
    };
  }
  if (
    s === "SEND_COMMITTED_NO_RETRY" ||
    s === "REQUEST_INVOKED"
  ) {
    return {
      disposition: "AMBIGUOUS_RECONCILE_ONLY",
      may_retry_send: false,
      may_resign: false,
      reason: "send committed/invoked without confirmed outcome",
    };
  }
  if (s === "SIGNED_PERSISTED" || s === "CREDENTIAL_AUTH_DERIVED") {
    return {
      disposition: "RESUME_NOT_ALLOWED",
      may_retry_send: false,
      may_resign: false,
      reason: "signer path may already be consumed; fail closed without resign",
    };
  }
  return {
    disposition: "CLEAN_CONTINUE",
    may_retry_send: false,
    may_resign: false,
    reason: `may continue carefully from ${s}`,
  };
}
