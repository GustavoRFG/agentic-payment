/**
 * buyer-signing-mandate-lifecycle — write-once one-shot mandate consumption.
 *
 * Conservative crash semantics: once JIT_DERIVATION_RESERVED, a failed or
 * interrupted derivation cannot automatically create another attempt/nonce.
 * Ambiguous states require a new human mandate.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B361_HUMAN_SIGNING_MANDATE_ALREADY_CONSUMED,
  BLOCKED_B361_MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE,
  BLOCKED_B361_MANDATE_LIFECYCLE_INVALID,
} from "./b361-execution-gates";
import { writeArtifactOnce } from "./buyer-authorization-artifacts";

export const SIGNING_MANDATE_LIFECYCLE_SCHEMA_VERSION =
  "trustforge_signing_mandate_lifecycle.v1" as const;

export const SIGNING_MANDATE_LIFECYCLE_ARTIFACT =
  "buyer_signing_mandate_lifecycle.json" as const;

export type SigningMandateLifecycleState =
  | "MANDATE_ISSUED"
  | "JIT_DERIVATION_RESERVED"
  | "FRESH_REQUIREMENTS_VALIDATED"
  | "ATTEMPT_RESERVED"
  | "UNSIGNED_PERSISTED"
  | "SIGNING_AUTHORIZATION_DERIVED"
  | "MANDATE_CONSUMED"
  | "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE";

const LEGAL: Readonly<
  Record<SigningMandateLifecycleState, readonly SigningMandateLifecycleState[]>
> = {
  MANDATE_ISSUED: ["JIT_DERIVATION_RESERVED", "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE"],
  JIT_DERIVATION_RESERVED: [
    "FRESH_REQUIREMENTS_VALIDATED",
    "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE",
  ],
  FRESH_REQUIREMENTS_VALIDATED: [
    "ATTEMPT_RESERVED",
    "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE",
  ],
  ATTEMPT_RESERVED: ["UNSIGNED_PERSISTED", "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE"],
  UNSIGNED_PERSISTED: [
    "SIGNING_AUTHORIZATION_DERIVED",
    "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE",
  ],
  SIGNING_AUTHORIZATION_DERIVED: ["MANDATE_CONSUMED"],
  MANDATE_CONSUMED: [],
  MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE: [],
};

export interface SigningMandateLifecycleRecord {
  readonly schema_version: typeof SIGNING_MANDATE_LIFECYCLE_SCHEMA_VERSION;
  readonly mandate_decision_id: string;
  readonly mandate_sha256: string;
  readonly state: SigningMandateLifecycleState;
  readonly updated_at: string;
  readonly run_id: string | null;
  readonly attempt_id: string | null;
  readonly unsigned_artifact_sha256: string | null;
  readonly derived_signing_authorization_sha256: string | null;
  readonly max_attempts: 1;
  readonly max_nonces: 1;
  readonly max_unsigned_artifacts: 1;
  readonly max_derived_signing_authorizations: 1;
  readonly notes: string | null;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function assertTransition(
  from: SigningMandateLifecycleState,
  to: SigningMandateLifecycleState,
): void {
  if (!LEGAL[from].includes(to)) {
    fail(
      BLOCKED_B361_MANDATE_LIFECYCLE_INVALID,
      `illegal lifecycle transition ${from} → ${to}`,
    );
  }
}

export class BuyerSigningMandateLedger {
  private readonly records = new Map<string, SigningMandateLifecycleRecord>();

  constructor(seed?: readonly SigningMandateLifecycleRecord[]) {
    for (const record of seed ?? []) {
      this.records.set(record.mandate_sha256, record);
    }
  }

  get(mandateSha256: string): SigningMandateLifecycleRecord | undefined {
    return this.records.get(mandateSha256);
  }

  assertNotConsumed(mandateSha256: string): void {
    const existing = this.get(mandateSha256);
    if (!existing) return;
    if (existing.state === "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE") {
      fail(
        BLOCKED_B361_MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE,
        `mandate ${existing.mandate_decision_id} is ambiguous after interrupted JIT derivation; issue a new human mandate`,
      );
    }
    if (
      existing.state === "MANDATE_CONSUMED" ||
      existing.state === "SIGNING_AUTHORIZATION_DERIVED" ||
      existing.state === "UNSIGNED_PERSISTED" ||
      existing.state === "ATTEMPT_RESERVED" ||
      existing.state === "JIT_DERIVATION_RESERVED" ||
      existing.state === "FRESH_REQUIREMENTS_VALIDATED"
    ) {
      fail(
        BLOCKED_B361_HUMAN_SIGNING_MANDATE_ALREADY_CONSUMED,
        `mandate ${existing.mandate_decision_id} already in state ${existing.state}; second derivation is forbidden`,
      );
    }
  }

  issue(input: {
    readonly mandateDecisionId: string;
    readonly mandateSha256: string;
    readonly now: Date;
  }): SigningMandateLifecycleRecord {
    this.assertNotConsumed(input.mandateSha256);
    if (this.records.has(input.mandateSha256)) {
      fail(
        BLOCKED_B361_HUMAN_SIGNING_MANDATE_ALREADY_CONSUMED,
        "mandate lifecycle already issued for this hash",
      );
    }
    const record: SigningMandateLifecycleRecord = {
      schema_version: SIGNING_MANDATE_LIFECYCLE_SCHEMA_VERSION,
      mandate_decision_id: input.mandateDecisionId,
      mandate_sha256: input.mandateSha256,
      state: "MANDATE_ISSUED",
      updated_at: input.now.toISOString(),
      run_id: null,
      attempt_id: null,
      unsigned_artifact_sha256: null,
      derived_signing_authorization_sha256: null,
      max_attempts: 1,
      max_nonces: 1,
      max_unsigned_artifacts: 1,
      max_derived_signing_authorizations: 1,
      notes: null,
    };
    this.records.set(input.mandateSha256, record);
    return record;
  }

  transition(input: {
    readonly mandateSha256: string;
    readonly to: SigningMandateLifecycleState;
    readonly now: Date;
    readonly runId?: string | null;
    readonly attemptId?: string | null;
    readonly unsignedArtifactSha256?: string | null;
    readonly derivedSigningAuthorizationSha256?: string | null;
    readonly notes?: string | null;
  }): SigningMandateLifecycleRecord {
    const existing = this.get(input.mandateSha256);
    if (!existing) {
      fail(BLOCKED_B361_MANDATE_LIFECYCLE_INVALID, "mandate lifecycle record missing");
    }
    assertTransition(existing.state, input.to);
    const next: SigningMandateLifecycleRecord = {
      ...existing,
      state: input.to,
      updated_at: input.now.toISOString(),
      run_id: input.runId ?? existing.run_id,
      attempt_id: input.attemptId ?? existing.attempt_id,
      unsigned_artifact_sha256:
        input.unsignedArtifactSha256 ?? existing.unsigned_artifact_sha256,
      derived_signing_authorization_sha256:
        input.derivedSigningAuthorizationSha256 ??
        existing.derived_signing_authorization_sha256,
      notes: input.notes ?? existing.notes,
    };
    this.records.set(input.mandateSha256, next);
    return next;
  }

  markAmbiguous(input: {
    readonly mandateSha256: string;
    readonly now: Date;
    readonly notes: string;
  }): SigningMandateLifecycleRecord {
    const existing = this.get(input.mandateSha256);
    if (!existing) {
      fail(BLOCKED_B361_MANDATE_LIFECYCLE_INVALID, "mandate lifecycle record missing");
    }
    if (
      existing.state === "MANDATE_CONSUMED" ||
      existing.state === "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE"
    ) {
      return existing;
    }
    assertTransition(existing.state, "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE");
    const next: SigningMandateLifecycleRecord = {
      ...existing,
      state: "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE",
      updated_at: input.now.toISOString(),
      notes: input.notes,
    };
    this.records.set(input.mandateSha256, next);
    return next;
  }

  snapshot(): readonly SigningMandateLifecycleRecord[] {
    return [...this.records.values()];
  }
}

export function persistSigningMandateLifecycle(
  directory: string,
  record: SigningMandateLifecycleRecord,
): { readonly path: string; readonly sha256: string } {
  return writeArtifactOnce(join(directory, SIGNING_MANDATE_LIFECYCLE_ARTIFACT), record);
}

export function loadSigningMandateLifecycle(
  directory: string,
): SigningMandateLifecycleRecord | null {
  const path = join(directory, SIGNING_MANDATE_LIFECYCLE_ARTIFACT);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as SigningMandateLifecycleRecord;
}

/**
 * Crash/restart recovery policy for a persisted lifecycle record.
 * Never generates another attempt/nonce/unsigned; may only finish deriving the
 * signing authorization for an already-persisted unsigned artifact.
 */
export function evaluateMandateCrashRecovery(
  record: SigningMandateLifecycleRecord,
): {
  readonly may_continue_derivation: boolean;
  readonly may_generate_new_attempt: false;
  readonly may_generate_new_nonce: false;
  readonly may_generate_new_unsigned: false;
  readonly action:
    | "COMPLETE_DERIVED_AUTHORIZATION_FOR_EXISTING_UNSIGNED"
    | "ALREADY_COMPLETE"
    | "REQUIRE_NEW_HUMAN_MANDATE";
} {
  const base = {
    may_generate_new_attempt: false as const,
    may_generate_new_nonce: false as const,
    may_generate_new_unsigned: false as const,
  };
  if (record.state === "MANDATE_CONSUMED") {
    return { ...base, may_continue_derivation: false, action: "ALREADY_COMPLETE" };
  }
  if (
    record.state === "UNSIGNED_PERSISTED" &&
    typeof record.unsigned_artifact_sha256 === "string" &&
    record.unsigned_artifact_sha256.length > 0
  ) {
    return {
      ...base,
      may_continue_derivation: true,
      action: "COMPLETE_DERIVED_AUTHORIZATION_FOR_EXISTING_UNSIGNED",
    };
  }
  return {
    ...base,
    may_continue_derivation: false,
    action: "REQUIRE_NEW_HUMAN_MANDATE",
  };
}
