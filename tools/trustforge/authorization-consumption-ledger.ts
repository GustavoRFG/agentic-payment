/**
 * authorization-consumption-ledger — durable single-shot human authorization consumption.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AUTHORIZATION_ALREADY_CONSUMED = "BLOCKED_AUTHORIZATION_ALREADY_CONSUMED" as const;

export interface AuthorizationConsumptionLedger {
  readonly authorization_hash: string;
  readonly authorization_path: string;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly max_payment_attempts: number;
  consumed_attempts: number;
  attempt_ids: string[];
  first_consumed_at: string | null;
  last_consumed_at: string | null;
  closed: boolean;
}

export function hashAuthorizationContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function authorizationLedgerPath(phase5RunDir: string): string {
  return join(phase5RunDir, "authorization_consumption_ledger.json");
}

function lockPath(ledgerPath: string): string {
  return `${ledgerPath}.lock`;
}

async function acquireLock(ledgerPath: string, timeoutMs = 5000): Promise<() => Promise<void>> {
  const lock = lockPath(ledgerPath);
  await mkdir(dirname(ledgerPath), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        try {
          await unlink(lock);
        } catch {
          /* lock already released */
        }
      };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`authorization ledger lock timeout: ${lock}`);
}

async function readLedger(ledgerPath: string): Promise<AuthorizationConsumptionLedger | null> {
  if (!existsSync(ledgerPath)) return null;
  return JSON.parse(await readFile(ledgerPath, "utf8")) as AuthorizationConsumptionLedger;
}

async function writeLedgerAtomic(
  ledgerPath: string,
  ledger: AuthorizationConsumptionLedger,
): Promise<void> {
  const tmp = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(tmp, ledgerPath);
}

export function isAuthorizationConsumed(ledger: AuthorizationConsumptionLedger | null): boolean {
  if (!ledger) return false;
  return ledger.consumed_attempts >= ledger.max_payment_attempts || ledger.closed;
}

export async function assertAuthorizationAvailable(input: {
  readonly ledgerPath: string;
  readonly authorizationHash: string;
  readonly maxPaymentAttempts: number;
}): Promise<void> {
  const ledger = await readLedger(input.ledgerPath);
  if (!ledger) return;
  if (ledger.authorization_hash !== input.authorizationHash) {
    throw new Error("BLOCKED_AUTHORIZATION_HASH_MISMATCH");
  }
  if (isAuthorizationConsumed(ledger)) {
    throw new Error(AUTHORIZATION_ALREADY_CONSUMED);
  }
  if (ledger.consumed_attempts >= input.maxPaymentAttempts) {
    throw new Error(AUTHORIZATION_ALREADY_CONSUMED);
  }
}

export async function reserveAuthorizationAttempt(input: {
  readonly ledgerPath: string;
  readonly authorizationHash: string;
  readonly authorizationPath: string;
  readonly provider: string;
  readonly serviceId: string;
  readonly endpoint: string;
  readonly maxPaymentAttempts: number;
  readonly attemptId: string;
  readonly now?: () => Date;
}): Promise<AuthorizationConsumptionLedger> {
  const now = input.now ?? (() => new Date());
  const release = await acquireLock(input.ledgerPath);
  try {
    let ledger = await readLedger(input.ledgerPath);
    if (ledger && ledger.authorization_hash !== input.authorizationHash) {
      throw new Error("BLOCKED_AUTHORIZATION_HASH_MISMATCH");
    }
    if (ledger && isAuthorizationConsumed(ledger)) {
      throw new Error(AUTHORIZATION_ALREADY_CONSUMED);
    }
    const at = now().toISOString();
    if (!ledger) {
      ledger = {
        authorization_hash: input.authorizationHash,
        authorization_path: input.authorizationPath,
        provider: input.provider,
        service_id: input.serviceId,
        endpoint: input.endpoint,
        max_payment_attempts: input.maxPaymentAttempts,
        consumed_attempts: 0,
        attempt_ids: [],
        first_consumed_at: null,
        last_consumed_at: null,
        closed: false,
      };
    }
    if (ledger.consumed_attempts >= ledger.max_payment_attempts) {
      throw new Error(AUTHORIZATION_ALREADY_CONSUMED);
    }
    ledger.consumed_attempts += 1;
    ledger.attempt_ids.push(input.attemptId);
    ledger.first_consumed_at = ledger.first_consumed_at ?? at;
    ledger.last_consumed_at = at;
    ledger.closed = ledger.consumed_attempts >= ledger.max_payment_attempts;
    await writeLedgerAtomic(input.ledgerPath, ledger);
    return ledger;
  } finally {
    await release();
  }
}
