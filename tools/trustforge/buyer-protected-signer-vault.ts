/**
 * buyer-protected-signer-vault — encrypted buyer key vault (no plaintext).
 *
 * Default location: %LOCALAPPDATA%\TrustForge\signers\
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
  BLOCKED_B4_VAULT_CORRUPT,
  GUARD_NO_PLAINTEXT_BUYER_KEY_PERSISTENCE,
  GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV,
  GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_FILE_PLAINTEXT,
} from "./b4-execution-gates";
import type { ProtectedSecretBackend } from "./windows-dpapi-protect";

export const PROTECTED_SIGNER_VAULT_SCHEMA =
  "trustforge_protected_signer_vault.v1" as const;

export interface ProtectedSignerVaultRecord {
  readonly schema_version: typeof PROTECTED_SIGNER_VAULT_SCHEMA;
  readonly provider_id: typeof B4_PROTECTED_SIGNER_PROVIDER_ID;
  readonly protection_scheme: string;
  readonly expected_public_address: string;
  /** Base64 ciphertext only — never plaintext. */
  readonly encrypted_secret_blob_b64: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export function defaultTrustForgeSignersDir(): string {
  const local =
    process.env.LOCALAPPDATA ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    "";
  if (!local) {
    fail(BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE, "LOCALAPPDATA/HOME unavailable");
  }
  return join(local, "TrustForge", "signers");
}

export function vaultPathForBuyer(expectedAddress: string, baseDir?: string): string {
  const addr = expectedAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    fail(BLOCKED_B4_VAULT_CORRUPT, "expected address malformed");
  }
  return join(baseDir ?? defaultTrustForgeSignersDir(), `buyer-${addr}.vault.json`);
}

export function applyRestrictiveWindowsAcl(filePath: string): {
  readonly applied: boolean;
  readonly detail: string;
} {
  void GUARD_NO_PLAINTEXT_BUYER_KEY_PERSISTENCE;
  if (process.platform !== "win32") {
    try {
      chmodSync(filePath, 0o600);
      return { applied: true, detail: "posix_0600" };
    } catch (error) {
      return {
        applied: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const user = process.env.USERNAME || process.env.USER || "";
  const result = spawnSync(
    "icacls",
    [filePath, "/inheritance:r", "/grant:r", `${user}:(R,W)`, "/grant:r", "SYSTEM:(F)"],
    { encoding: "utf8", windowsHide: true },
  );
  return {
    applied: result.status === 0,
    detail: (result.stdout || result.stderr || "").trim().slice(0, 500),
  };
}

export function writeProtectedSignerVault(input: {
  readonly path: string;
  readonly expectedPublicAddress: string;
  readonly plaintextKey: Uint8Array;
  readonly backend: ProtectedSecretBackend;
  readonly now?: Date;
}): {
  readonly record: ProtectedSignerVaultRecord;
  readonly acl: { readonly applied: boolean; readonly detail: string };
} {
  void GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV;
  void GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_FILE_PLAINTEXT;
  if (process.env.BUYER_PRIVATE_KEY || process.env.SEPOLIA_BUYER_PRIVATE_KEY) {
    fail(
      GUARD_NO_PROTECTED_SIGNER_FALLBACK_TO_ENV,
      "env private key present during vault write; refuse",
    );
  }
  const now = (input.now ?? new Date()).toISOString();
  const ciphertext = input.backend.protect(input.plaintextKey);
  const record: ProtectedSignerVaultRecord = {
    schema_version: PROTECTED_SIGNER_VAULT_SCHEMA,
    provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
    protection_scheme: input.backend.scheme,
    expected_public_address: input.expectedPublicAddress,
    encrypted_secret_blob_b64: Buffer.from(ciphertext).toString("base64"),
    created_at: now,
    updated_at: now,
  };
  mkdirSync(join(input.path, ".."), { recursive: true });
  writeFileSync(input.path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  const acl = applyRestrictiveWindowsAcl(input.path);
  return { record, acl };
}

export function loadProtectedSignerVault(path: string): ProtectedSignerVaultRecord {
  if (!existsSync(path)) {
    fail(BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE, `vault missing: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as ProtectedSignerVaultRecord;
  if (raw.schema_version !== PROTECTED_SIGNER_VAULT_SCHEMA) {
    fail(BLOCKED_B4_VAULT_CORRUPT, "unsupported vault schema");
  }
  if (raw.provider_id !== B4_PROTECTED_SIGNER_PROVIDER_ID) {
    fail(BLOCKED_B4_VAULT_CORRUPT, "provider_id mismatch");
  }
  if (
    typeof raw.encrypted_secret_blob_b64 !== "string" ||
    raw.encrypted_secret_blob_b64.length < 8
  ) {
    fail(BLOCKED_B4_VAULT_CORRUPT, "ciphertext missing");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw.expected_public_address)) {
    fail(BLOCKED_B4_VAULT_CORRUPT, "expected_public_address invalid");
  }
  return raw;
}

export function decryptProtectedSignerVault(input: {
  readonly record: ProtectedSignerVaultRecord;
  readonly backend: ProtectedSecretBackend;
}): Uint8Array {
  try {
    const cipher = new Uint8Array(
      Buffer.from(input.record.encrypted_secret_blob_b64, "base64"),
    );
    return input.backend.unprotect(cipher);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(BLOCKED_B4_VAULT_CORRUPT, `decrypt failed: ${message.split("\n")[0]}`);
  }
}

/** Safe evidence — never includes ciphertext or plaintext. */
export function sanitizeVaultEvidence(input: {
  readonly path: string;
  readonly record: ProtectedSignerVaultRecord;
  readonly acl?: { readonly applied: boolean; readonly detail: string };
}): Record<string, unknown> {
  return {
    provider_id: input.record.provider_id,
    vault_path: input.path,
    protection_scheme: input.record.protection_scheme,
    expected_public_address: input.record.expected_public_address,
    created_at: input.record.created_at,
    updated_at: input.record.updated_at,
    vault_integrity_state: "PRESENT",
    encrypted_secret_blob: "[REDACTED]",
    acl: input.acl ?? null,
  };
}
