/**
 * buyer-secure-signer-setup — one-time Protect Wallet flow (Windows masked dialog).
 * Derives address before storage. Persists DPAPI ciphertext only.
 */

import {
  B4_PROTECTED_SIGNER_PROVIDER_ID,
  BLOCKED_B4_SIGNER_SETUP_ADDRESS_MISMATCH,
  BLOCKED_B4_SIGNER_SETUP_CANCELLED,
  BLOCKED_B4_SIGNER_SETUP_INVALID,
  GUARD_NO_PLAINTEXT_BUYER_KEY_PERSISTENCE,
} from "./b4-execution-gates";
import { type WindowsMaskedSecretDialog, privateKeyAsciiToCredentialBytes } from "./buyer-windows-masked-secret-dialog";
import {
  decryptProtectedSignerVault,
  loadProtectedSignerVault,
  sanitizeVaultEvidence,
  vaultPathForBuyer,
  writeProtectedSignerVault,
} from "./buyer-protected-signer-vault";
import {
  createWindowsDpapiCurrentUserBackend,
  type ProtectedSecretBackend,
} from "./windows-dpapi-protect";
import { zeroCredentialBytes } from "./buyer-credential-transport-frame";
import { deriveAddressFromPrivateKeyBytes } from "./windows-dpapi-local-signer";

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

export interface SecureSignerSetupResult {
  readonly provider_id: typeof B4_PROTECTED_SIGNER_PROVIDER_ID;
  readonly expected_signer: string;
  readonly derived_signer_match: true;
  readonly plaintext_persisted: false;
  readonly vault_path: string;
  readonly vault_ready: true;
  readonly evidence: Record<string, unknown>;
}

export async function runSecureSignerSetup(input: {
  readonly expectedWallet: string;
  readonly dialog: WindowsMaskedSecretDialog;
  readonly backend?: ProtectedSecretBackend;
  readonly vaultBaseDir?: string;
  readonly now?: Date;
}): Promise<SecureSignerSetupResult> {
  void GUARD_NO_PLAINTEXT_BUYER_KEY_PERSISTENCE;
  const expected = input.expectedWallet.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(expected)) {
    fail(BLOCKED_B4_SIGNER_SETUP_INVALID, "expectedWallet malformed");
  }

  let entry: Awaited<ReturnType<WindowsMaskedSecretDialog["showOnce"]>>;
  try {
    entry = await input.dialog.showOnce({
      expectedWallet: input.expectedWallet,
      title: "TRUSTFORGE — Secure Signer Setup",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/CANCELLED|CLOSED/i.test(message)) {
      fail(BLOCKED_B4_SIGNER_SETUP_CANCELLED, message.split("\n")[0]!);
    }
    fail(BLOCKED_B4_SIGNER_SETUP_INVALID, message.split("\n")[0]!);
  }

  const ascii = entry.credentialAscii;
  let plaintext: Uint8Array | null = null;
  try {
    // Dialog returns ASCII hex bytes; convert to 32-byte scalar before protect.
    const asciiText = Buffer.from(ascii).toString("ascii");
    plaintext = privateKeyAsciiToCredentialBytes(asciiText);
    const derived = deriveAddressFromPrivateKeyBytes(plaintext);
    if (derived.toLowerCase() !== expected) {
      fail(
        BLOCKED_B4_SIGNER_SETUP_ADDRESS_MISMATCH,
        "derived address does not match expected wallet; nothing persisted",
      );
    }
    const backend = input.backend ?? createWindowsDpapiCurrentUserBackend();
    const path = vaultPathForBuyer(expected, input.vaultBaseDir);
    const written = writeProtectedSignerVault({
      path,
      expectedPublicAddress: input.expectedWallet,
      plaintextKey: plaintext,
      backend,
      now: input.now,
    });
    const loaded = loadProtectedSignerVault(path);
    const again = decryptProtectedSignerVault({ record: loaded, backend });
    try {
      const check = deriveAddressFromPrivateKeyBytes(again);
      if (check.toLowerCase() !== expected) {
        fail(BLOCKED_B4_SIGNER_SETUP_ADDRESS_MISMATCH, "post-write self-test mismatch");
      }
    } finally {
      zeroCredentialBytes(again);
    }
    return {
      provider_id: B4_PROTECTED_SIGNER_PROVIDER_ID,
      expected_signer: input.expectedWallet,
      derived_signer_match: true,
      plaintext_persisted: false,
      vault_path: path,
      vault_ready: true,
      evidence: sanitizeVaultEvidence({
        path,
        record: written.record,
        acl: written.acl,
      }),
    };
  } finally {
    zeroCredentialBytes(ascii);
    if (plaintext) zeroCredentialBytes(plaintext);
  }
}

/** Setup self-test without payment — decrypt, match address, clear. */
export function verifyProtectedSignerVaultReady(input: {
  readonly expectedWallet: string;
  readonly backend: ProtectedSecretBackend;
  readonly vaultBaseDir?: string;
}): {
  readonly VAULT_READY: true;
  readonly EXPECTED_SIGNER_MATCH: true;
  readonly provider: typeof B4_PROTECTED_SIGNER_PROVIDER_ID;
} {
  const path = vaultPathForBuyer(input.expectedWallet, input.vaultBaseDir);
  const record = loadProtectedSignerVault(path);
  const plain = decryptProtectedSignerVault({ record, backend: input.backend });
  try {
    const derived = deriveAddressFromPrivateKeyBytes(plain).toLowerCase();
    if (derived !== input.expectedWallet.toLowerCase()) {
      fail(BLOCKED_B4_SIGNER_SETUP_ADDRESS_MISMATCH, "vault self-test address mismatch");
    }
  } finally {
    zeroCredentialBytes(plain);
  }
  return {
    VAULT_READY: true,
    EXPECTED_SIGNER_MATCH: true,
    provider: B4_PROTECTED_SIGNER_PROVIDER_ID,
  };
}
