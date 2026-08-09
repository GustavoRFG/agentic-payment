/**
 * buyer-signature-attempt-ledger — one-shot signature consumption.
 *
 * Once the signer is invoked for a signing authorization + unsigned hash, the
 * attempt is consumed even if persistence later fails or the process crashes.
 * No automatic resign.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS,
  BLOCKED_B3_SIGNATURE_ATTEMPT_CONSUMED,
} from "./b3-execution-gates";
import { writeArtifactOnce } from "./buyer-authorization-artifacts";

export const SIGNATURE_ATTEMPT_LEDGER_SCHEMA_VERSION =
  "trustforge_signature_attempt_ledger.v1" as const;

export const SIGNATURE_ATTEMPT_LEDGER_ARTIFACT =
  "buyer_signature_attempt_ledger.json" as const;

export type SignatureAttemptStatus =
  | "SIGNER_INVOKED"
  | "SIGNED_PERSISTED"
  | "AMBIGUOUS_AFTER_SIGNER";

export interface SignatureAttemptLedgerRecord {
  readonly schema_version: typeof SIGNATURE_ATTEMPT_LEDGER_SCHEMA_VERSION;
  readonly signing_authorization_decision_id: string;
  readonly signing_authorization_sha256: string;
  readonly unsigned_artifact_sha256: string;
  readonly attempt_id: string;
  readonly run_id: string;
  readonly status: SignatureAttemptStatus;
  readonly signer_invoked_at: string;
  readonly max_signatures: 1;
  readonly allow_resign: false;
  readonly signature_attempt_id: string;
}

function keyFor(decisionId: string, unsignedHash: string): string {
  return `${decisionId}::${unsignedHash}`;
}

/**
 * In-memory + optional durable ledger. Consuming marks SIGNER_INVOKED before
 * the signer returns; persistence failures upgrade to AMBIGUOUS_AFTER_SIGNER.
 */
export class BuyerSignatureAttemptLedger {
  private readonly records = new Map<string, SignatureAttemptLedgerRecord>();

  constructor(
    seed?: readonly SignatureAttemptLedgerRecord[],
  ) {
    for (const record of seed ?? []) {
      this.records.set(
        keyFor(record.signing_authorization_decision_id, record.unsigned_artifact_sha256),
        record,
      );
    }
  }

  get(decisionId: string, unsignedHash: string): SignatureAttemptLedgerRecord | undefined {
    return this.records.get(keyFor(decisionId, unsignedHash));
  }

  assertNotConsumed(decisionId: string, unsignedHash: string): void {
    const existing = this.get(decisionId, unsignedHash);
    if (!existing) return;
    if (existing.status === "AMBIGUOUS_AFTER_SIGNER") {
      throw new Error(
        `${BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS}: signature attempt ${existing.signature_attempt_id} is ambiguous after signer invocation; explicit human handling is required`,
      );
    }
    throw new Error(
      `${BLOCKED_B3_SIGNATURE_ATTEMPT_CONSUMED}: signature attempt already consumed with status ${existing.status}; resign is forbidden`,
    );
  }

  /** Mark consumption immediately before/as signer is invoked. */
  markSignerInvoked(input: {
    readonly signingAuthorizationDecisionId: string;
    readonly signingAuthorizationSha256: string;
    readonly unsignedArtifactSha256: string;
    readonly attemptId: string;
    readonly runId: string;
    readonly now: Date;
    readonly signatureAttemptId: string;
  }): SignatureAttemptLedgerRecord {
    this.assertNotConsumed(
      input.signingAuthorizationDecisionId,
      input.unsignedArtifactSha256,
    );
    const record: SignatureAttemptLedgerRecord = {
      schema_version: SIGNATURE_ATTEMPT_LEDGER_SCHEMA_VERSION,
      signing_authorization_decision_id: input.signingAuthorizationDecisionId,
      signing_authorization_sha256: input.signingAuthorizationSha256,
      unsigned_artifact_sha256: input.unsignedArtifactSha256,
      attempt_id: input.attemptId,
      run_id: input.runId,
      status: "SIGNER_INVOKED",
      signer_invoked_at: input.now.toISOString(),
      max_signatures: 1,
      allow_resign: false,
      signature_attempt_id: input.signatureAttemptId,
    };
    this.records.set(
      keyFor(input.signingAuthorizationDecisionId, input.unsignedArtifactSha256),
      record,
    );
    return record;
  }

  markSignedPersisted(decisionId: string, unsignedHash: string): SignatureAttemptLedgerRecord {
    const existing = this.get(decisionId, unsignedHash);
    if (!existing) {
      throw new Error(
        `${BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS}: cannot mark signed persistence without a prior signer invocation`,
      );
    }
    const updated: SignatureAttemptLedgerRecord = {
      ...existing,
      status: "SIGNED_PERSISTED",
    };
    this.records.set(keyFor(decisionId, unsignedHash), updated);
    return updated;
  }

  markAmbiguous(decisionId: string, unsignedHash: string): SignatureAttemptLedgerRecord {
    const existing = this.get(decisionId, unsignedHash);
    if (!existing) {
      throw new Error(
        `${BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS}: cannot mark ambiguity without a prior signer invocation`,
      );
    }
    const updated: SignatureAttemptLedgerRecord = {
      ...existing,
      status: "AMBIGUOUS_AFTER_SIGNER",
    };
    this.records.set(keyFor(decisionId, unsignedHash), updated);
    return updated;
  }

  persist(directory: string, decisionId: string, unsignedHash: string) {
    const record = this.get(decisionId, unsignedHash);
    if (!record) {
      throw new Error(
        `${BLOCKED_B3_SIGNATURE_ATTEMPT_AMBIGUOUS}: no ledger record to persist`,
      );
    }
    return writeArtifactOnce(join(directory, SIGNATURE_ATTEMPT_LEDGER_ARTIFACT), record);
  }

  static loadFromDirectory(directory: string): BuyerSignatureAttemptLedger {
    const path = join(directory, SIGNATURE_ATTEMPT_LEDGER_ARTIFACT);
    if (!existsSync(path)) {
      return new BuyerSignatureAttemptLedger();
    }
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SignatureAttemptLedgerRecord;
    return new BuyerSignatureAttemptLedger([parsed]);
  }
}
