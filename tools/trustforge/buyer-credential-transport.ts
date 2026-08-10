/**
 * buyer-credential-transport — authorized one-shot byte transport.
 *
 * Does not know wallets, accounts, signing, or payment details.
 * Pipe readable ≠ credential access authorized; both are required.
 */

import {
  BLOCKED_B34_CREDENTIAL_TRANSPORT_AMBIGUOUS,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_CONSUMED,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED,
  assertB34CredentialTransportUnavailable,
  assertB34NoTransportFallback,
} from "./b34-execution-gates";
import type { AuthorizedCredentialAccessRequest } from "./buyer-credential-provider";
import {
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "./explicit-runtime-key-credential-provider";

export type CredentialTransportState =
  | "TRANSPORT_UNREAD"
  | "TRANSPORT_READ_INVOKED"
  | "TRANSPORT_CONSUMED"
  | "TRANSPORT_AMBIGUOUS";

/**
 * Opaque capability stamped only after signing + credential-access validation,
 * explicit-runtime-key selection, and credential-acquisition reservation.
 */
export interface AuthorizedCredentialTransportRead {
  readonly __brand: "AuthorizedCredentialTransportRead";
  readonly transportId: string;
  readonly decisionId: string;
  readonly unsignedArtifactSha256: string;
  readonly providerId: typeof EXPLICIT_RUNTIME_KEY_PROVIDER_ID;
  readonly credentialKind: typeof EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND;
  readonly authorizedRequest: AuthorizedCredentialAccessRequest;
}

export interface OneShotCredentialTransport {
  readonly transportId: string;
  readOnce(authorization: AuthorizedCredentialTransportRead): Promise<Uint8Array>;
}

export function stampAuthorizedCredentialTransportRead(input: {
  readonly transportId: string;
  readonly authorizedRequest: AuthorizedCredentialAccessRequest;
}): AuthorizedCredentialTransportRead {
  const req = input.authorizedRequest;
  if (req.__brand !== "AuthorizedCredentialAccessRequest") {
    throw new Error(
      `${BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED}: AuthorizedCredentialAccessRequest required`,
    );
  }
  const auth = req.accessAuthorization;
  if (auth.provider_id !== EXPLICIT_RUNTIME_KEY_PROVIDER_ID) {
    throw new Error(
      `${BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED}: transport only for explicit-runtime-key`,
    );
  }
  if (auth.credential_kind !== EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND) {
    throw new Error(
      `${BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED}: credential_kind mismatch`,
    );
  }
  if (auth.credential_access_authorized !== true) {
    throw new Error(
      `${BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED}: credential access not authorized`,
    );
  }
  return Object.freeze({
    __brand: "AuthorizedCredentialTransportRead" as const,
    transportId: input.transportId,
    decisionId: auth.decision_id,
    unsignedArtifactSha256: req.context.unsignedArtifactSha256,
    providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
    authorizedRequest: req,
  });
}

/** In-memory one-shot transport lifecycle (no secrets persisted). */
export class CredentialTransportLedger {
  private readonly states = new Map<string, CredentialTransportState>();

  private key(transportId: string, decisionId: string, unsignedHash: string): string {
    return `${transportId}|${decisionId}|${unsignedHash}`;
  }

  getState(
    transportId: string,
    decisionId: string,
    unsignedHash: string,
  ): CredentialTransportState {
    return this.states.get(this.key(transportId, decisionId, unsignedHash)) ?? "TRANSPORT_UNREAD";
  }

  assertUnread(transportId: string, decisionId: string, unsignedHash: string): void {
    const state = this.getState(transportId, decisionId, unsignedHash);
    if (state === "TRANSPORT_UNREAD") return;
    if (state === "TRANSPORT_AMBIGUOUS") {
      throw new Error(
        `${BLOCKED_B34_CREDENTIAL_TRANSPORT_AMBIGUOUS}: transport ${transportId} is ambiguous; no reread`,
      );
    }
    throw new Error(
      `${BLOCKED_B34_CREDENTIAL_TRANSPORT_CONSUMED}: transport ${transportId} already ${state}; no reread`,
    );
  }

  markReadInvoked(transportId: string, decisionId: string, unsignedHash: string): void {
    this.assertUnread(transportId, decisionId, unsignedHash);
    this.states.set(
      this.key(transportId, decisionId, unsignedHash),
      "TRANSPORT_READ_INVOKED",
    );
  }

  markConsumed(transportId: string, decisionId: string, unsignedHash: string): void {
    this.states.set(this.key(transportId, decisionId, unsignedHash), "TRANSPORT_CONSUMED");
  }

  markAmbiguous(transportId: string, decisionId: string, unsignedHash: string): void {
    this.states.set(this.key(transportId, decisionId, unsignedHash), "TRANSPORT_AMBIGUOUS");
  }
}

/**
 * Wrap a raw byte source with one-shot + authorization checks.
 * The source must not fall back to env/argv/file/clipboard.
 */
export function createAuthorizedOneShotTransport(input: {
  readonly transportId: string;
  readonly ledger?: CredentialTransportLedger;
  readonly readBytes: () => Promise<Uint8Array>;
}): OneShotCredentialTransport {
  const ledger = input.ledger ?? new CredentialTransportLedger();
  return {
    transportId: input.transportId,
    async readOnce(authorization: AuthorizedCredentialTransportRead): Promise<Uint8Array> {
      if (authorization.__brand !== "AuthorizedCredentialTransportRead") {
        throw new Error(
          `${BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED}: AuthorizedCredentialTransportRead brand required`,
        );
      }
      if (authorization.transportId !== input.transportId) {
        throw new Error(
          `${BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED}: transportId mismatch`,
        );
      }
      ledger.markReadInvoked(
        authorization.transportId,
        authorization.decisionId,
        authorization.unsignedArtifactSha256,
      );
      try {
        const bytes = await input.readBytes();
        ledger.markConsumed(
          authorization.transportId,
          authorization.decisionId,
          authorization.unsignedArtifactSha256,
        );
        return bytes;
      } catch (error) {
        ledger.markAmbiguous(
          authorization.transportId,
          authorization.decisionId,
          authorization.unsignedArtifactSha256,
        );
        // Never fall back to alternate secret sources.
        if (
          error instanceof Error &&
          (error.message.includes("BLOCKED_B34_") ||
            error.message.includes("BLOCKED_B33_") ||
            error.message.includes("BLOCKED_B31_"))
        ) {
          throw error;
        }
        assertB34CredentialTransportUnavailable(
          error instanceof Error ? error.message : "transport read failed",
        );
      }
    },
  };
}

/** Explicit denial helper if productive code tries env/argv fallback. */
export function rejectRuntimeKeyTransportFallback(_reason: string): never {
  void _reason;
  assertB34NoTransportFallback();
}
