/**
 * windows-dpapi-protect — CurrentUser DPAPI protect/unprotect.
 *
 * Production: PowerShell + System.Security.Cryptography.ProtectedData.
 * Tests: inject ProtectedSecretBackend (no real DPAPI required).
 *
 * Threat model: binds ciphertext to the Windows user profile. Does NOT protect
 * against malware already executing as the same interactive user.
 */

import { spawnSync } from "node:child_process";

import {
  BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
  BLOCKED_B4_VAULT_CORRUPT,
  GUARD_NO_PLAINTEXT_BUYER_KEY_PERSISTENCE,
} from "./b4-execution-gates";

export interface ProtectedSecretBackend {
  readonly scheme: "DPAPI_CURRENT_USER" | "SYNTHETIC_TEST_XOR";
  protect(plaintext: Uint8Array): Uint8Array;
  unprotect(ciphertext: Uint8Array): Uint8Array;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

/** Synthetic backend for unit/loopback tests — NOT for operational vaults. */
export function createSyntheticXorProtectedSecretBackend(
  padByte = 0x5a,
): ProtectedSecretBackend {
  void GUARD_NO_PLAINTEXT_BUYER_KEY_PERSISTENCE;
  return {
    scheme: "SYNTHETIC_TEST_XOR",
    protect(plaintext) {
      return Uint8Array.from(plaintext, (b) => b ^ padByte);
    },
    unprotect(ciphertext) {
      return Uint8Array.from(ciphertext, (b) => b ^ padByte);
    },
  };
}

function psProtectUnprotect(mode: "Protect" | "Unprotect", inputB64: string): string {
  const script =
    mode === "Protect"
      ? `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${inputB64}')
$prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($prot)
`
      : `
Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String('${inputB64}')
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($plain)
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) {
    fail(
      BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE,
      `DPAPI ${mode} failed: ${(result.stderr || result.stdout || "").split("\n")[0]}`,
    );
  }
  const out = (result.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop();
  if (!out || !/^[A-Za-z0-9+/=]+$/.test(out)) {
    fail(BLOCKED_B4_VAULT_CORRUPT, `DPAPI ${mode} returned empty/invalid payload`);
  }
  return out;
}

export function createWindowsDpapiCurrentUserBackend(): ProtectedSecretBackend {
  if (process.platform !== "win32") {
    fail(BLOCKED_B4_PROTECTED_SIGNER_UNAVAILABLE, "DPAPI requires win32");
  }
  return {
    scheme: "DPAPI_CURRENT_USER",
    protect(plaintext) {
      const b64 = Buffer.from(plaintext).toString("base64");
      const out = psProtectUnprotect("Protect", b64);
      return new Uint8Array(Buffer.from(out, "base64"));
    },
    unprotect(ciphertext) {
      const b64 = Buffer.from(ciphertext).toString("base64");
      const out = psProtectUnprotect("Unprotect", b64);
      return new Uint8Array(Buffer.from(out, "base64"));
    },
  };
}
