/**
 * buyer-credential-access-ledger — one-shot credential acquisition consumption.
 *
 * Once acquireSigner is invoked, the access authorization is consumed or
 * ambiguous. No silent re-acquisition.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BLOCKED_B31_CREDENTIAL_ACCESS_AMBIGUOUS,
  BLOCKED_B31_CREDENTIAL_ACCESS_CONSUMED,
} from "./b31-execution-gates";
import { writeArtifactOnce } from "./buyer-authorization-artifacts";

export const CREDENTIAL_ACCESS_LEDGER_SCHEMA_VERSION =
  "trustforge_credential_access_ledger.v1" as const;

export const CREDENTIAL_ACCESS_LEDGER_ARTIFACT =
  "buyer_credential_access_ledger.json" as const;

export type CredentialAccessStatus =
  | "CREDENTIAL_ACCESS_RESERVED"
  | "CREDENTIAL_ACQUISITION_INVOKED"
  | "AMBIGUOUS_AFTER_CREDENTIAL_ACQUISITION";

export interface CredentialAccessLedgerRecord {
  readonly schema_version: typeof CREDENTIAL_ACCESS_LEDGER_SCHEMA_VERSION;
  readonly credential_access_decision_id: string;
  readonly credential_access_authorization_sha256: string;
  readonly unsigned_artifact_sha256: string;
  readonly provider_id: string;
  readonly status: CredentialAccessStatus;
  readonly reserved_at: string;
  readonly acquisition_invoked_at: string | null;
  readonly max_credential_acquisitions: 1;
  readonly allow_fallback: false;
}

function keyFor(decisionId: string, unsignedHash: string): string {
  return `${decisionId}::${unsignedHash}`;
}

export class BuyerCredentialAccessLedger {
  private readonly records = new Map<string, CredentialAccessLedgerRecord>();

  constructor(seed?: readonly CredentialAccessLedgerRecord[]) {
    for (const record of seed ?? []) {
      this.records.set(
        keyFor(record.credential_access_decision_id, record.unsigned_artifact_sha256),
        record,
      );
    }
  }

  get(decisionId: string, unsignedHash: string): CredentialAccessLedgerRecord | undefined {
    return this.records.get(keyFor(decisionId, unsignedHash));
  }

  assertNotConsumed(decisionId: string, unsignedHash: string): void {
    const existing = this.get(decisionId, unsignedHash);
    if (!existing) return;
    if (existing.status === "AMBIGUOUS_AFTER_CREDENTIAL_ACQUISITION") {
      throw new Error(
        `${BLOCKED_B31_CREDENTIAL_ACCESS_AMBIGUOUS}: credential access ${existing.credential_access_decision_id} is ambiguous; explicit human handling is required`,
      );
    }
    throw new Error(
      `${BLOCKED_B31_CREDENTIAL_ACCESS_CONSUMED}: credential access already consumed with status ${existing.status}`,
    );
  }

  reserve(input: {
    readonly decisionId: string;
    readonly authorizationSha256: string;
    readonly unsignedArtifactSha256: string;
    readonly providerId: string;
    readonly now: Date;
  }): CredentialAccessLedgerRecord {
    this.assertNotConsumed(input.decisionId, input.unsignedArtifactSha256);
    const record: CredentialAccessLedgerRecord = {
      schema_version: CREDENTIAL_ACCESS_LEDGER_SCHEMA_VERSION,
      credential_access_decision_id: input.decisionId,
      credential_access_authorization_sha256: input.authorizationSha256,
      unsigned_artifact_sha256: input.unsignedArtifactSha256,
      provider_id: input.providerId,
      status: "CREDENTIAL_ACCESS_RESERVED",
      reserved_at: input.now.toISOString(),
      acquisition_invoked_at: null,
      max_credential_acquisitions: 1,
      allow_fallback: false,
    };
    this.records.set(keyFor(input.decisionId, input.unsignedArtifactSha256), record);
    return record;
  }

  markAcquisitionInvoked(decisionId: string, unsignedHash: string, now: Date): CredentialAccessLedgerRecord {
    const existing = this.get(decisionId, unsignedHash);
    if (!existing || existing.status !== "CREDENTIAL_ACCESS_RESERVED") {
      throw new Error(
        `${BLOCKED_B31_CREDENTIAL_ACCESS_AMBIGUOUS}: cannot mark acquisition without a reserved access`,
      );
    }
    const updated: CredentialAccessLedgerRecord = {
      ...existing,
      status: "CREDENTIAL_ACQUISITION_INVOKED",
      acquisition_invoked_at: now.toISOString(),
    };
    this.records.set(keyFor(decisionId, unsignedHash), updated);
    return updated;
  }

  markAmbiguous(decisionId: string, unsignedHash: string): CredentialAccessLedgerRecord {
    const existing = this.get(decisionId, unsignedHash);
    if (!existing) {
      throw new Error(
        `${BLOCKED_B31_CREDENTIAL_ACCESS_AMBIGUOUS}: cannot mark ambiguity without a prior reservation`,
      );
    }
    const updated: CredentialAccessLedgerRecord = {
      ...existing,
      status: "AMBIGUOUS_AFTER_CREDENTIAL_ACQUISITION",
    };
    this.records.set(keyFor(decisionId, unsignedHash), updated);
    return updated;
  }

  persist(directory: string, decisionId: string, unsignedHash: string) {
    const record = this.get(decisionId, unsignedHash);
    if (!record) {
      throw new Error(
        `${BLOCKED_B31_CREDENTIAL_ACCESS_AMBIGUOUS}: no credential-access ledger record to persist`,
      );
    }
    return writeArtifactOnce(join(directory, CREDENTIAL_ACCESS_LEDGER_ARTIFACT), record);
  }

  static loadFromDirectory(directory: string): BuyerCredentialAccessLedger {
    const path = join(directory, CREDENTIAL_ACCESS_LEDGER_ARTIFACT);
    if (!existsSync(path)) return new BuyerCredentialAccessLedger();
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CredentialAccessLedgerRecord;
    return new BuyerCredentialAccessLedger([parsed]);
  }
}
