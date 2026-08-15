/**
 * authority-consumption-ledger — append-only budget consumption view (B.6.3).
 * No mutable remainingBudget. Ambiguous spend reserves budget.
 */

import { BLOCKED_B63_AUTHORITY_TAMPER } from "./b63-execution-gates";
import { canonicalJsonSha256 } from "./x402-seller-requirements-binding";

export type ConsumptionEventKind =
  | "AUTHORITY_GRANTED"
  | "CONSUMPTION_RESERVED"
  | "CONSUMPTION_CONFIRMED"
  | "CONSUMPTION_RELEASED"
  | "CONSUMPTION_AMBIGUOUS"
  | "AUTHORITY_REVOKED";

export interface AuthorityConsumptionEvent {
  readonly eventId: string;
  readonly kind: ConsumptionEventKind;
  readonly authorityId: string;
  readonly amountAtomic: string;
  readonly asset: string;
  readonly at: string;
  readonly paymentApprovalIntentHash: string | null;
  readonly prevEventHash: string | null;
  readonly eventHash: string;
}

export interface AuthorityConsumptionLedger {
  readonly schemaVersion: "trustforge_authority_consumption_ledger.v1";
  readonly authorityId: string;
  readonly events: readonly AuthorityConsumptionEvent[];
  readonly tipHash: string | null;
  readonly ledgerHash: string;
}

export function consumptionEventHash(
  e: Omit<AuthorityConsumptionEvent, "eventHash">,
): string {
  return canonicalJsonSha256({
    eventId: e.eventId,
    kind: e.kind,
    authorityId: e.authorityId,
    amountAtomic: e.amountAtomic,
    asset: e.asset,
    at: e.at,
    paymentApprovalIntentHash: e.paymentApprovalIntentHash,
    prevEventHash: e.prevEventHash,
  });
}

export function buildEmptyConsumptionLedger(
  authorityId: string,
): AuthorityConsumptionLedger {
  const events: AuthorityConsumptionEvent[] = [];
  return {
    schemaVersion: "trustforge_authority_consumption_ledger.v1",
    authorityId,
    events,
    tipHash: null,
    ledgerHash: canonicalJsonSha256({ authorityId, events: [] }),
  };
}

export function appendConsumptionEvent(
  ledger: AuthorityConsumptionLedger,
  input: Omit<AuthorityConsumptionEvent, "eventHash" | "prevEventHash">,
): AuthorityConsumptionLedger {
  if (ledger.authorityId !== input.authorityId) {
    throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: authorityId mismatch`);
  }
  const prevEventHash = ledger.tipHash;
  const withoutHash = { ...input, prevEventHash };
  const event: AuthorityConsumptionEvent = {
    ...withoutHash,
    eventHash: consumptionEventHash(withoutHash),
  };
  const events = [...ledger.events, event];
  return {
    schemaVersion: "trustforge_authority_consumption_ledger.v1",
    authorityId: ledger.authorityId,
    events,
    tipHash: event.eventHash,
    ledgerHash: canonicalJsonSha256({
      authorityId: ledger.authorityId,
      events: events.map((e) => e.eventHash),
    }),
  };
}

export function assertConsumptionLedgerIntegrity(
  ledger: AuthorityConsumptionLedger,
): { readonly ok: true } {
  let prev: string | null = null;
  for (const e of ledger.events) {
    if (e.prevEventHash !== prev) {
      throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: consumption chain break`);
    }
    if (consumptionEventHash(e) !== e.eventHash) {
      throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: consumption event hash`);
    }
    prev = e.eventHash;
  }
  if (ledger.tipHash !== prev) {
    throw new Error(`${BLOCKED_B63_AUTHORITY_TAMPER}: tipHash mismatch`);
  }
  return { ok: true };
}

export interface DerivedBudgetView {
  readonly spentConfirmed: string;
  readonly reservedPending: string;
  readonly reservedAmbiguous: string;
  readonly transactionCountCharged: number;
  readonly availableAggregate: string;
  readonly windowSpendCharged: string;
  readonly windowTxCharged: number;
}

function sumAtomic(amounts: readonly string[]): bigint {
  let t = 0n;
  for (const a of amounts) {
    t += BigInt(a);
  }
  return t;
}

export function deriveAvailableBudget(input: {
  readonly ledger: AuthorityConsumptionLedger;
  readonly maxAggregateSpend: string;
  readonly accountingWindowMs: number;
  readonly now: Date;
}): DerivedBudgetView {
  assertConsumptionLedgerIntegrity(input.ledger);
  const confirmed: string[] = [];
  const reserved: string[] = [];
  const ambiguous: string[] = [];
  let txCount = 0;
  const windowStart = input.now.getTime() - input.accountingWindowMs;
  const windowAmounts: string[] = [];
  let windowTx = 0;

  for (const e of input.ledger.events) {
    const atMs = Date.parse(e.at);
    if (e.kind === "CONSUMPTION_CONFIRMED") {
      confirmed.push(e.amountAtomic);
      txCount += 1;
      if (atMs >= windowStart) {
        windowAmounts.push(e.amountAtomic);
        windowTx += 1;
      }
    } else if (e.kind === "CONSUMPTION_RESERVED") {
      reserved.push(e.amountAtomic);
      txCount += 1;
      if (atMs >= windowStart) {
        windowAmounts.push(e.amountAtomic);
        windowTx += 1;
      }
    } else if (e.kind === "CONSUMPTION_AMBIGUOUS") {
      ambiguous.push(e.amountAtomic);
      txCount += 1;
      if (atMs >= windowStart) {
        windowAmounts.push(e.amountAtomic);
        windowTx += 1;
      }
    } else if (e.kind === "CONSUMPTION_RELEASED") {
      // release subtracts from reserved/ambiguous conceptually by recording negative?
      // For simplicity: RELEASED events reduce charged counts by amount
      // Conservative: only reduce reserved buckets via explicit RELEASED with same amount tracking.
      // Model RELEASED as reducing reservedPending/ambiguous by amountAtomic.
      const amt = BigInt(e.amountAtomic);
      // Apply as negative against reserved first in derived view via separate released list
      void amt;
    }
  }

  // Apply RELEASED against reserved+ambiguous (FIFO-ish sum reduction)
  let released = 0n;
  for (const e of input.ledger.events) {
    if (e.kind === "CONSUMPTION_RELEASED") {
      released += BigInt(e.amountAtomic);
      if (Date.parse(e.at) >= windowStart) {
        // reduce window charges
        windowTx = Math.max(0, windowTx - 1);
      }
      txCount = Math.max(0, txCount - 1);
    }
  }

  const spentConfirmed = sumAtomic(confirmed);
  let reservedPending = sumAtomic(reserved);
  let reservedAmbiguous = sumAtomic(ambiguous);
  // Consume release against reserved then ambiguous
  let remRelease = released;
  if (remRelease > reservedPending) {
    remRelease -= reservedPending;
    reservedPending = 0n;
  } else {
    reservedPending -= remRelease;
    remRelease = 0n;
  }
  if (remRelease > reservedAmbiguous) {
    reservedAmbiguous = 0n;
  } else {
    reservedAmbiguous -= remRelease;
  }

  let windowSpend = sumAtomic(windowAmounts);
  if (released > 0n) {
    windowSpend = windowSpend > released ? windowSpend - released : 0n;
  }

  const charged = spentConfirmed + reservedPending + reservedAmbiguous;
  const maxAgg = BigInt(input.maxAggregateSpend);
  const available = maxAgg > charged ? maxAgg - charged : 0n;

  return {
    spentConfirmed: spentConfirmed.toString(),
    reservedPending: reservedPending.toString(),
    reservedAmbiguous: reservedAmbiguous.toString(),
    transactionCountCharged: txCount,
    availableAggregate: available.toString(),
    windowSpendCharged: windowSpend.toString(),
    windowTxCharged: windowTx,
  };
}
