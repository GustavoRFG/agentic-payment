/**
 * ledger-reuse-validation — identity checks before offline ledger reuse.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface LedgerReuseIdentity {
  readonly network: string;
  readonly chainId: number;
  readonly buyer: string;
  readonly asset: string;
}

export interface LedgerReuseValidationResult {
  readonly ok: boolean;
  readonly reason: string | null;
}

export function validateLedgerIdentity(
  ledger: Record<string, unknown>,
  expected: LedgerReuseIdentity,
): LedgerReuseValidationResult {
  const schema = String(ledger.schema_name ?? "");
  const version = String(ledger.schema_version ?? "");
  if (schema !== "trustforge_onchain_settlement_ledger") {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: unsupported schema_name" };
  }
  if (!version.startsWith("0.2")) {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: unsupported schema_version" };
  }
  const chain = String(ledger.chain ?? "").toLowerCase();
  if (chain !== expected.network.toLowerCase()) {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: network" };
  }
  const chainId = Number(ledger.chain_id);
  if (!Number.isFinite(chainId) || chainId !== expected.chainId) {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: chain_id" };
  }
  const wallet = String(ledger.wallet ?? "").toLowerCase();
  if (wallet !== expected.buyer.toLowerCase()) {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: buyer wallet" };
  }
  const asset = String(ledger.usdc_contract ?? "").toLowerCase();
  if (asset !== expected.asset.toLowerCase()) {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: asset" };
  }
  if (!ledger.generated_at_utc && !ledger.scanned_to_block) {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: missing ledger metadata" };
  }
  return { ok: true, reason: null };
}

export async function validateLedgerManifestHash(
  ledgerPath: string,
  ledger: Record<string, unknown>,
  manifestPath: string,
): Promise<LedgerReuseValidationResult> {
  const expected = ledger.ledger_sha256 ?? ledger.manifest_sha256;
  if (typeof expected !== "string" || !expected.trim()) {
    return { ok: true, reason: null };
  }
  try {
    const manifestRaw = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestRaw) as Record<string, unknown>;
    const manifestHash = String(manifest.ledger_sha256 ?? manifest.sha256 ?? "");
    if (manifestHash && manifestHash !== expected) {
      return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: manifest hash" };
    }
    const ledgerRaw = await readFile(ledgerPath, "utf8");
    const actual = createHash("sha256").update(ledgerRaw, "utf8").digest("hex");
    if (actual !== expected.toLowerCase()) {
      return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: ledger_sha256" };
    }
    return { ok: true, reason: null };
  } catch {
    return { ok: false, reason: "REUSE_LEDGER_IDENTITY_MISMATCH: manifest unreadable" };
  }
}
