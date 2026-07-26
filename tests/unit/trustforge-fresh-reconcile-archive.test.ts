import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { archiveStaleBlockedLedger } from "../../tools/trustforge/x402-classify-runner";

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fresh-reconcile-"));
  ledgerPath = join(dir, "onchain_settlement_ledger.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("archiveStaleBlockedLedger (--fresh-reconcile)", () => {
  it("archives a blocked ledger (safe:false) aside, never deleting it", async () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({ reconciliation_status: "RECONCILIATION_RPC_TIMEOUT", safe_to_use_for_payment_verification: false }),
    );
    const archived = await archiveStaleBlockedLedger(ledgerPath, "20260726_010203");

    expect(archived).toBe(`${ledgerPath}.stale_blocked_20260726_010203`);
    expect(existsSync(ledgerPath)).toBe(false); // moved, so a fresh reconcile runs
    expect(existsSync(archived!)).toBe(true); // never deleted
    // Content preserved in the archive.
    const preserved = JSON.parse(readFileSync(archived!, "utf8"));
    expect(preserved.safe_to_use_for_payment_verification).toBe(false);
  });

  it("leaves a safe ledger (safe:true) untouched", async () => {
    writeFileSync(
      ledgerPath,
      JSON.stringify({ reconciliation_status: "RECONCILIATION_PASS", safe_to_use_for_payment_verification: true }),
    );
    const archived = await archiveStaleBlockedLedger(ledgerPath, "20260726_010203");
    expect(archived).toBeNull();
    expect(existsSync(ledgerPath)).toBe(true);
  });

  it("returns null when there is no ledger to archive", async () => {
    expect(await archiveStaleBlockedLedger(ledgerPath, "20260726_010203")).toBeNull();
  });
});
