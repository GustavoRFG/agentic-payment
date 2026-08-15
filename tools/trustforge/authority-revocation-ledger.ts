/**
 * authority-revocation-ledger — append-only revocation current-view (B.6.3).
 */

import { BLOCKED_B63_AUTHORITY_TAMPER } from "./b63-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export interface AuthorityRevocationEvent {
  readonly eventId: string;
  readonly authorityId: string;
  readonly revokedAt: string;
  readonly reason: string;
  readonly prevEventHash: string | null;
  readonly eventHash: string;
}

export interface AuthorityRevocationLedger {
  readonly schemaVersion: "trustforge_authority_revocation_ledger.v1";
  readonly events: readonly AuthorityRevocationEvent[];
  readonly tipHash: string | null;
  readonly ledgerHash: string;
}

export function revocationEventHash(
  e: Omit<AuthorityRevocationEvent, "eventHash">,
): string {
  return canonicalJsonSha256({
    eventId: e.eventId,
    authorityId: e.authorityId,
    revokedAt: e.revokedAt,
    reason: e.reason,
    prevEventHash: e.prevEventHash,
  });
}

export function buildEmptyRevocationLedger(): AuthorityRevocationLedger {
  return {
    schemaVersion: "trustforge_authority_revocation_ledger.v1",
    events: [],
    tipHash: null,
    ledgerHash: canonicalJsonSha256({ events: [] }),
  };
}

export function appendRevocationEvent(
  ledger: AuthorityRevocationLedger,
  input: Omit<AuthorityRevocationEvent, "eventHash" | "prevEventHash">,
): AuthorityRevocationLedger {
  const withoutHash = { ...input, prevEventHash: ledger.tipHash };
  const event: AuthorityRevocationEvent = {
    ...withoutHash,
    eventHash: revocationEventHash(withoutHash),
  };
  const events = [...ledger.events, event];
  return {
    schemaVersion: "trustforge_authority_revocation_ledger.v1",
    events,
    tipHash: event.eventHash,
    ledgerHash: canonicalJsonSha256({ events: events.map((e) => e.eventHash) }),
  };
}

export function assertRevocationLedgerIntegrity(
  ledger: AuthorityRevocationLedger,
): { readonly ok: true } {
  let prev: string | null = null;
  for (const e of ledger.events) {
    if (e.prevEventHash !== prev) {
      throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: revocation chain break`);
    }
    if (revocationEventHash(e) !== e.eventHash) {
      throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: revocation event hash`);
    }
    prev = e.eventHash;
  }
  return { ok: true };
}

export function isAuthorityRevoked(
  ledger: AuthorityRevocationLedger,
  authorityId: string,
): boolean {
  assertRevocationLedgerIntegrity(ledger);
  return ledger.events.some((e) => e.authorityId === authorityId);
}
