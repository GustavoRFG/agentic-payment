/**
 * buyer-conditional-mandate-lifecycle — one-shot conditional mandate consumption.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B363_CONDITIONAL_MANDATE_ALREADY_CONSUMED,
  BLOCKED_B363_CONDITIONAL_MANDATE_AMBIGUOUS_REAUTHORIZE,
  BLOCKED_B363_CONDITIONAL_MANDATE_LIFECYCLE_INVALID,
} from "./b363-execution-gates";
import { writeArtifactOnce } from "./buyer-authorization-artifacts";

export const CONDITIONAL_MANDATE_LIFECYCLE_SCHEMA_VERSION =
  "trustforge_conditional_mandate_lifecycle.v1" as const;

export const CONDITIONAL_MANDATE_LIFECYCLE_ARTIFACT =
  "buyer_conditional_mandate_lifecycle.json" as const;

export type ConditionalMandateLifecycleState =
  | "MANDATE_ISSUED"
  | "JIT_DERIVATION_RESERVED"
  | "FRESH_REQUIREMENTS_VALIDATED"
  | "ATTEMPT_RESERVED"
  | "UNSIGNED_PERSISTED"
  | "SIGNING_AUTHORIZATION_DERIVED"
  | "CREDENTIAL_AUTHORIZATION_DERIVED"
  | "MANDATE_CONSUMED"
  | "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE";

const LEGAL: Readonly<
  Record<ConditionalMandateLifecycleState, readonly ConditionalMandateLifecycleState[]>
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
  SIGNING_AUTHORIZATION_DERIVED: [
    "CREDENTIAL_AUTHORIZATION_DERIVED",
    "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE",
  ],
  CREDENTIAL_AUTHORIZATION_DERIVED: ["MANDATE_CONSUMED"],
  MANDATE_CONSUMED: [],
  MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE: [],
};

export interface ConditionalMandateLifecycleRecord {
  readonly schema_version: typeof CONDITIONAL_MANDATE_LIFECYCLE_SCHEMA_VERSION;
  readonly mandate_decision_id: string;
  readonly mandate_sha256: string;
  readonly state: ConditionalMandateLifecycleState;
  readonly updated_at: string;
  readonly run_id: string | null;
  readonly attempt_id: string | null;
  readonly unsigned_artifact_sha256: string | null;
  readonly derived_signing_authorization_sha256: string | null;
  readonly derived_credential_access_authorization_sha256: string | null;
  readonly max_attempts: 1;
  readonly max_nonces: 1;
  readonly max_unsigned_artifacts: 1;
  readonly max_signing_authorizations: 1;
  readonly max_credential_acquisitions: 1;
  readonly max_signer_invocations: 1;
  readonly notes: string | null;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

function assertTransition(
  from: ConditionalMandateLifecycleState,
  to: ConditionalMandateLifecycleState,
): void {
  if (!LEGAL[from].includes(to)) {
    fail(
      BLOCKED_B363_CONDITIONAL_MANDATE_LIFECYCLE_INVALID,
      `illegal lifecycle transition ${from} → ${to}`,
    );
  }
}

export class BuyerConditionalMandateLedger {
  private readonly records = new Map<string, ConditionalMandateLifecycleRecord>();

  constructor(seed?: readonly ConditionalMandateLifecycleRecord[]) {
    for (const record of seed ?? []) {
      this.records.set(record.mandate_sha256, record);
    }
  }

  get(mandateSha256: string): ConditionalMandateLifecycleRecord | undefined {
    return this.records.get(mandateSha256);
  }

  assertNotConsumed(mandateSha256: string): void {
    const existing = this.get(mandateSha256);
    if (!existing) return;
    if (existing.state === "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE") {
      fail(
        BLOCKED_B363_CONDITIONAL_MANDATE_AMBIGUOUS_REAUTHORIZE,
        `mandate ${existing.mandate_decision_id} is ambiguous; issue a new human mandate`,
      );
    }
    if (existing.state !== "MANDATE_ISSUED") {
      fail(
        BLOCKED_B363_CONDITIONAL_MANDATE_ALREADY_CONSUMED,
        `mandate ${existing.mandate_decision_id} already in state ${existing.state}`,
      );
    }
  }

  issue(input: {
    readonly mandateDecisionId: string;
    readonly mandateSha256: string;
    readonly now: Date;
  }): ConditionalMandateLifecycleRecord {
    this.assertNotConsumed(input.mandateSha256);
    if (this.records.has(input.mandateSha256)) {
      fail(
        BLOCKED_B363_CONDITIONAL_MANDATE_ALREADY_CONSUMED,
        "mandate lifecycle already issued for this hash",
      );
    }
    const record: ConditionalMandateLifecycleRecord = {
      schema_version: CONDITIONAL_MANDATE_LIFECYCLE_SCHEMA_VERSION,
      mandate_decision_id: input.mandateDecisionId,
      mandate_sha256: input.mandateSha256,
      state: "MANDATE_ISSUED",
      updated_at: input.now.toISOString(),
      run_id: null,
      attempt_id: null,
      unsigned_artifact_sha256: null,
      derived_signing_authorization_sha256: null,
      derived_credential_access_authorization_sha256: null,
      max_attempts: 1,
      max_nonces: 1,
      max_unsigned_artifacts: 1,
      max_signing_authorizations: 1,
      max_credential_acquisitions: 1,
      max_signer_invocations: 1,
      notes: null,
    };
    this.records.set(input.mandateSha256, record);
    return record;
  }

  transition(input: {
    readonly mandateSha256: string;
    readonly to: ConditionalMandateLifecycleState;
    readonly now: Date;
    readonly runId?: string | null;
    readonly attemptId?: string | null;
    readonly unsignedArtifactSha256?: string | null;
    readonly derivedSigningAuthorizationSha256?: string | null;
    readonly derivedCredentialAccessAuthorizationSha256?: string | null;
    readonly notes?: string | null;
  }): ConditionalMandateLifecycleRecord {
    const existing = this.get(input.mandateSha256);
    if (!existing) {
      fail(BLOCKED_B363_CONDITIONAL_MANDATE_LIFECYCLE_INVALID, "mandate lifecycle record missing");
    }
    assertTransition(existing.state, input.to);
    const next: ConditionalMandateLifecycleRecord = {
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
      derived_credential_access_authorization_sha256:
        input.derivedCredentialAccessAuthorizationSha256 ??
        existing.derived_credential_access_authorization_sha256,
      notes: input.notes ?? existing.notes,
    };
    this.records.set(input.mandateSha256, next);
    return next;
  }

  markAmbiguous(input: {
    readonly mandateSha256: string;
    readonly now: Date;
    readonly notes: string;
  }): ConditionalMandateLifecycleRecord {
    const existing = this.get(input.mandateSha256);
    if (!existing) {
      fail(BLOCKED_B363_CONDITIONAL_MANDATE_LIFECYCLE_INVALID, "mandate lifecycle record missing");
    }
    if (
      existing.state === "MANDATE_CONSUMED" ||
      existing.state === "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE"
    ) {
      return existing;
    }
    assertTransition(existing.state, "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE");
    const next: ConditionalMandateLifecycleRecord = {
      ...existing,
      state: "MANDATE_CONSUMED_AMBIGUOUS_REAUTHORIZE",
      updated_at: input.now.toISOString(),
      notes: input.notes,
    };
    this.records.set(input.mandateSha256, next);
    return next;
  }
}

export function persistConditionalMandateLifecycle(
  directory: string,
  record: ConditionalMandateLifecycleRecord,
): { readonly path: string; readonly sha256: string } {
  return writeArtifactOnce(join(directory, CONDITIONAL_MANDATE_LIFECYCLE_ARTIFACT), record);
}

export function loadConditionalMandateLifecycle(
  directory: string,
): ConditionalMandateLifecycleRecord | null {
  const path = join(directory, CONDITIONAL_MANDATE_LIFECYCLE_ARTIFACT);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as ConditionalMandateLifecycleRecord;
}

export function evaluateConditionalMandateCrashRecovery(
  record: ConditionalMandateLifecycleRecord,
): {
  readonly may_generate_new_attempt: false;
  readonly may_generate_new_nonce: false;
  readonly may_generate_new_unsigned: false;
  readonly may_derive_second_credential_auth: false;
  readonly action:
    | "COMPLETE_SIGNING_AUTHORIZATION_FOR_EXISTING_UNSIGNED"
    | "COMPLETE_CREDENTIAL_AUTHORIZATION_FOR_EXISTING_SIGNING_AUTH"
    | "ALREADY_COMPLETE"
    | "REQUIRE_NEW_HUMAN_MANDATE";
} {
  const base = {
    may_generate_new_attempt: false as const,
    may_generate_new_nonce: false as const,
    may_generate_new_unsigned: false as const,
    may_derive_second_credential_auth: false as const,
  };
  if (record.state === "MANDATE_CONSUMED" || record.state === "CREDENTIAL_AUTHORIZATION_DERIVED") {
    return { ...base, action: "ALREADY_COMPLETE" };
  }
  if (
    record.state === "SIGNING_AUTHORIZATION_DERIVED" &&
    record.derived_signing_authorization_sha256
  ) {
    return {
      ...base,
      action: "COMPLETE_CREDENTIAL_AUTHORIZATION_FOR_EXISTING_SIGNING_AUTH",
    };
  }
  if (record.state === "UNSIGNED_PERSISTED" && record.unsigned_artifact_sha256) {
    return {
      ...base,
      action: "COMPLETE_SIGNING_AUTHORIZATION_FOR_EXISTING_UNSIGNED",
    };
  }
  return { ...base, action: "REQUIRE_NEW_HUMAN_MANDATE" };
}
