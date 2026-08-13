/**
 * payment-candidate-ledger — durable candidate lifecycle (no secrets).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { B5_LEDGER_SCHEMA } from "./b5-execution-gates";
import type { CandidateEconomicAssessment } from "./payment-candidate-economics";
import type { CandidatePolicyVerdict } from "./payment-candidate-policy";
import type { PaymentCandidateSelection } from "./payment-candidate-selection";
import type { PaymentCandidateV1 } from "./payment-candidate-v1";

export type PaymentCandidateLedgerState =
  | "DISCOVERED"
  | "NORMALIZED"
  | "POLICY_EVALUATED"
  | "ELIGIBLE"
  | "INELIGIBLE"
  | "ASSESSED"
  | "SELECTED"
  | "NOT_SELECTED"
  | "HUMAN_APPROVED"
  | "HUMAN_REJECTED"
  | "HUMAN_ABORTED"
  | "EXECUTION_LINKED"
  | "FINAL_OUTCOME";

export interface PaymentCandidateLedgerEntry {
  readonly schema_version: typeof B5_LEDGER_SCHEMA;
  readonly candidate_id: string;
  readonly observation_id: string;
  readonly state: PaymentCandidateLedgerState;
  readonly updated_at: string;
  readonly candidate_sha256?: string;
  readonly policy_verdict?: CandidatePolicyVerdictKindRef;
  readonly selection_id?: string;
  readonly execution_run_id?: string;
  readonly notes?: readonly string[];
}

type CandidatePolicyVerdictKindRef = CandidatePolicyVerdict["verdict"];

export interface PaymentCandidateLedger {
  readonly schema_version: typeof B5_LEDGER_SCHEMA;
  readonly entries: PaymentCandidateLedgerEntry[];
}

export function emptyPaymentCandidateLedger(): PaymentCandidateLedger {
  return { schema_version: B5_LEDGER_SCHEMA, entries: [] };
}

export function appendLedgerEntry(
  ledger: PaymentCandidateLedger,
  entry: Omit<PaymentCandidateLedgerEntry, "schema_version">,
): PaymentCandidateLedger {
  return {
    schema_version: B5_LEDGER_SCHEMA,
    entries: [
      ...ledger.entries,
      { schema_version: B5_LEDGER_SCHEMA, ...entry },
    ],
  };
}

export function recordNormalizedCandidates(
  ledger: PaymentCandidateLedger,
  candidates: readonly PaymentCandidateV1[],
  now: Date,
): PaymentCandidateLedger {
  let next = ledger;
  for (const c of candidates) {
    next = appendLedgerEntry(next, {
      candidate_id: c.candidate_id,
      observation_id: c.observation_id,
      state: "NORMALIZED",
      updated_at: now.toISOString(),
      notes: [`discovery_source=${c.discovery_source}`],
    });
  }
  return next;
}

export function recordPolicyAndAssessment(
  ledger: PaymentCandidateLedger,
  candidate: PaymentCandidateV1,
  verdict: CandidatePolicyVerdict,
  assessment: CandidateEconomicAssessment,
  now: Date,
): PaymentCandidateLedger {
  void assessment;
  let next = appendLedgerEntry(ledger, {
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    state: "POLICY_EVALUATED",
    updated_at: now.toISOString(),
    policy_verdict: verdict.verdict,
  });
  next = appendLedgerEntry(next, {
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    state: verdict.verdict === "ELIGIBLE" ? "ELIGIBLE" : "INELIGIBLE",
    updated_at: now.toISOString(),
    policy_verdict: verdict.verdict,
  });
  next = appendLedgerEntry(next, {
    candidate_id: candidate.candidate_id,
    observation_id: candidate.observation_id,
    state: "ASSESSED",
    updated_at: now.toISOString(),
  });
  return next;
}

export function recordSelection(
  ledger: PaymentCandidateLedger,
  selection: PaymentCandidateSelection,
  now: Date,
): PaymentCandidateLedger {
  let next = ledger;
  next = appendLedgerEntry(next, {
    candidate_id: selection.selected_candidate_id,
    observation_id: selection.selected_observation_id,
    state: "SELECTED",
    updated_at: now.toISOString(),
    selection_id: selection.selection_id,
  });
  for (const r of selection.rejected) {
    next = appendLedgerEntry(next, {
      candidate_id: r.candidate_id,
      observation_id: r.observation_id,
      state: "NOT_SELECTED",
      updated_at: now.toISOString(),
      selection_id: selection.selection_id,
      notes: [r.reason],
    });
  }
  return next;
}

export function persistPaymentCandidateLedger(
  directory: string,
  ledger: PaymentCandidateLedger,
): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "payment_candidate_ledger.json"),
    `${JSON.stringify(ledger, null, 2)}\n`,
  );
}

export function loadPaymentCandidateLedger(
  directory: string,
): PaymentCandidateLedger | null {
  const path = join(directory, "payment_candidate_ledger.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as PaymentCandidateLedger;
}
