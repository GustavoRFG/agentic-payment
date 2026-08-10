/**
 * buyer-secret-entry-authorization — one-shot human secret-entry privilege.
 *
 * Opening a prompt does not grant credential access by itself.
 * Capability is stamped only after credential-access authorization + reservation.
 */

import {
  BLOCKED_B35_SECRET_ENTRY_AMBIGUOUS,
  BLOCKED_B35_SECRET_ENTRY_BEFORE_GATE,
  BLOCKED_B35_SECRET_ENTRY_CONSUMED,
  BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED,
} from "./b35-execution-gates";
import type { AuthorizedCredentialAccessRequest } from "./buyer-credential-provider";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "./explicit-runtime-key-credential-provider";

export type SecretEntryState =
  | "SECRET_ENTRY_RESERVED"
  | "SECRET_ENTRY_INVOKED"
  | "SECRET_ENTRY_CONSUMED"
  | "SECRET_ENTRY_ABORTED"
  | "SECRET_ENTRY_AMBIGUOUS";

export interface AuthorizedSecretEntry {
  readonly __brand: "AuthorizedSecretEntry";
  readonly decisionId: string;
  readonly unsignedArtifactSha256: string;
  readonly providerId: typeof EXPLICIT_RUNTIME_KEY_PROVIDER_ID;
  readonly credentialKind: typeof EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND;
  readonly authorizedRequest: AuthorizedCredentialAccessRequest;
}

export function stampAuthorizedSecretEntry(input: {
  readonly authorizedRequest: AuthorizedCredentialAccessRequest;
  readonly credentialAccessEnabled: boolean;
}): AuthorizedSecretEntry {
  if (input.credentialAccessEnabled !== true) {
    throw new Error(
      `${BLOCKED_B35_SECRET_ENTRY_BEFORE_GATE}: secret entry forbidden while credential_access_enabled is false`,
    );
  }
  const req = input.authorizedRequest;
  if (req.__brand !== "AuthorizedCredentialAccessRequest") {
    throw new Error(
      `${BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED}: AuthorizedCredentialAccessRequest required`,
    );
  }
  const auth = req.accessAuthorization;
  if (auth.provider_id !== EXPLICIT_RUNTIME_KEY_PROVIDER_ID) {
    throw new Error(
      `${BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED}: secret entry only for explicit-runtime-key`,
    );
  }
  if (auth.credential_kind !== EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND) {
    throw new Error(
      `${BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED}: credential_kind mismatch`,
    );
  }
  if (auth.credential_access_authorized !== true) {
    throw new Error(
      `${BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED}: credential access not authorized`,
    );
  }
  return Object.freeze({
    __brand: "AuthorizedSecretEntry" as const,
    decisionId: auth.decision_id,
    unsignedArtifactSha256: req.context.unsignedArtifactSha256,
    providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
    authorizedRequest: req,
  });
}

export class SecretEntryLedger {
  private readonly states = new Map<string, SecretEntryState>();

  private key(decisionId: string, unsignedHash: string): string {
    return `${decisionId}|${unsignedHash}`;
  }

  getState(decisionId: string, unsignedHash: string): SecretEntryState | null {
    return this.states.get(this.key(decisionId, unsignedHash)) ?? null;
  }

  reserve(decisionId: string, unsignedHash: string): void {
    const k = this.key(decisionId, unsignedHash);
    const existing = this.states.get(k);
    if (existing && existing !== "SECRET_ENTRY_RESERVED") {
      throw new Error(
        `${BLOCKED_B35_SECRET_ENTRY_CONSUMED}: secret entry already ${existing}`,
      );
    }
    this.states.set(k, "SECRET_ENTRY_RESERVED");
  }

  assertReserved(decisionId: string, unsignedHash: string): void {
    const state = this.getState(decisionId, unsignedHash);
    if (state !== "SECRET_ENTRY_RESERVED") {
      if (state === "SECRET_ENTRY_AMBIGUOUS" || state === "SECRET_ENTRY_ABORTED") {
        throw new Error(
          `${BLOCKED_B35_SECRET_ENTRY_AMBIGUOUS}: secret entry is ${state}; no re-prompt`,
        );
      }
      throw new Error(
        `${BLOCKED_B35_SECRET_ENTRY_CONSUMED}: secret entry state ${state ?? "missing"}; no re-prompt`,
      );
    }
  }

  markInvoked(decisionId: string, unsignedHash: string): void {
    this.assertReserved(decisionId, unsignedHash);
    this.states.set(this.key(decisionId, unsignedHash), "SECRET_ENTRY_INVOKED");
  }

  markConsumed(decisionId: string, unsignedHash: string): void {
    this.states.set(this.key(decisionId, unsignedHash), "SECRET_ENTRY_CONSUMED");
  }

  markAborted(decisionId: string, unsignedHash: string): void {
    this.states.set(this.key(decisionId, unsignedHash), "SECRET_ENTRY_ABORTED");
  }

  markAmbiguous(decisionId: string, unsignedHash: string): void {
    this.states.set(this.key(decisionId, unsignedHash), "SECRET_ENTRY_AMBIGUOUS");
  }
}
