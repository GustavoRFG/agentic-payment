/**
 * buyer-windows-masked-secret-dialog — WINDOWS_MASKED_SECRET_DIALOG_ONE_SHOT.
 *
 * Human pastes into a native Windows masked TextBox (WinForms PasswordChar).
 * Application never programmatically reads the clipboard.
 * Immutable runtime string erasure is NOT guaranteed after UI entry.
 *
 * Productive path: PowerShell STA + System.Windows.Forms.
 * Tests inject a synthetic dialog (no GUI / no clipboard).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCKED_B352_SECRET_DIALOG_CANCELLED,
  BLOCKED_B352_SECRET_DIALOG_CLOSED,
  BLOCKED_B352_SECRET_DIALOG_INVALID,
  BLOCKED_B352_SECRET_DIALOG_PLATFORM,
  BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT,
  BLOCKED_B352_SECRET_DIALOG_UNAUTHORIZED,
  assertB352SecretDialogCancelled,
  assertB352SecretDialogClosed,
} from "./b352-execution-gates";
import { B352_SECRET_ENTRY_MECHANISM } from "./buyer-secret-entry-mechanism";
import {
  type AuthorizedSecretEntry,
  type SecretEntryLedger,
} from "./buyer-secret-entry-authorization";
import { zeroCredentialBytes } from "./buyer-credential-transport-frame";

export { B352_SECRET_ENTRY_MECHANISM };

const HEX64 = /^[0-9a-fA-F]{64}$/;
const HEX66 = /^0x[0-9a-fA-F]{64}$/;

export interface WindowsMaskedSecretDialogRequest {
  readonly expectedWallet: string;
  readonly title?: string;
}

export interface WindowsMaskedSecretDialogResult {
  readonly credentialAscii: Uint8Array;
  readonly evidence: {
    readonly mechanism: typeof B352_SECRET_ENTRY_MECHANISM;
    readonly dialog_opened: true;
    readonly programmatic_clipboard_read: false;
    readonly accepted_ascii_length: number;
    readonly format_valid: true;
  };
}

/** Narrow injectable surface — productive WinForms or synthetic test double. */
export interface WindowsMaskedSecretDialog {
  readonly mechanism: typeof B352_SECRET_ENTRY_MECHANISM;
  showOnce(request: WindowsMaskedSecretDialogRequest): Promise<WindowsMaskedSecretDialogResult>;
}

export function isValidPrivateKeyAscii(value: string): boolean {
  // Exact contract: no trim, no normalization.
  return HEX64.test(value) || HEX66.test(value);
}

export function privateKeyAsciiToCredentialBytes(value: string): Uint8Array {
  if (!isValidPrivateKeyAscii(value)) {
    throw new Error(
      `${BLOCKED_B352_SECRET_DIALOG_INVALID}: private key must be exactly 64 hex chars or 0x + 64 hex chars`,
    );
  }
  const hex = value.length === 66 ? value.slice(2) : value;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function formatSafeKeyMetadata(value: string): {
  readonly length: number;
  readonly format: "valid" | "invalid";
} {
  return {
    length: value.length,
    format: isValidPrivateKeyAscii(value) ? "valid" : "invalid",
  };
}

function defaultDialogScriptPath(): string {
  // tools/trustforge/windows-masked-secret-dialog.ps1 next to this module.
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "windows-masked-secret-dialog.ps1");
}

/** Production WinForms dialog via PowerShell STA. No clipboard APIs in-app. */
export function createWinFormsMaskedSecretDialog(options?: {
  readonly scriptPath?: string;
  readonly powershellPath?: string;
}): WindowsMaskedSecretDialog {
  const scriptPath = options?.scriptPath ?? defaultDialogScriptPath();
  const powershellPath = options?.powershellPath ?? "powershell.exe";
  let opened = false;

  return {
    mechanism: B352_SECRET_ENTRY_MECHANISM,
    async showOnce(request) {
      if (opened) {
        throw new Error(
          `${BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT}: Windows masked secret dialog already opened`,
        );
      }
      opened = true;
      if (process.platform !== "win32") {
        throw new Error(
          `${BLOCKED_B352_SECRET_DIALOG_PLATFORM}: Windows masked secret dialog requires win32`,
        );
      }
      if (!/^0x[0-9a-fA-F]{40}$/.test(request.expectedWallet)) {
        throw new Error(
          `${BLOCKED_B352_SECRET_DIALOG_INVALID}: expectedWallet must be a 0x-prefixed address`,
        );
      }

      const ascii = await new Promise<Uint8Array>((resolve, reject) => {
        const child = spawn(
          powershellPath,
          [
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-ExpectedWallet",
            request.expectedWallet,
          ],
          {
            windowsHide: false,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        const chunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout.on("data", (c: Buffer) => chunks.push(c));
        child.stderr.on("data", (c: Buffer) => errChunks.push(c));
        child.on("error", (error) => {
          reject(
            new Error(
              `${BLOCKED_B352_SECRET_DIALOG_PLATFORM}: failed to spawn dialog (${error.message})`,
            ),
          );
        });
        child.on("close", (code) => {
          if (code === 2) {
            reject(new Error(`${BLOCKED_B352_SECRET_DIALOG_CANCELLED}: user cancelled`));
            return;
          }
          if (code === 3) {
            reject(new Error(`${BLOCKED_B352_SECRET_DIALOG_CLOSED}: window closed`));
            return;
          }
          if (code !== 0) {
            // Never echo stderr if it could contain secrets; keep sanitized.
            reject(
              new Error(
                `${BLOCKED_B352_SECRET_DIALOG_INVALID}: dialog exited with code ${code ?? "null"}`,
              ),
            );
            return;
          }
          const buf = Buffer.concat(chunks);
          resolve(new Uint8Array(buf));
        });
      });

      // Re-validate in Node (exact contract). Convert to string only for format check.
      let asString = "";
      try {
        asString = Buffer.from(ascii).toString("ascii");
        if (!isValidPrivateKeyAscii(asString)) {
          zeroCredentialBytes(ascii);
          throw new Error(
            `${BLOCKED_B352_SECRET_DIALOG_INVALID}: dialog payload failed structural validation`,
          );
        }
        return {
          credentialAscii: ascii,
          evidence: {
            mechanism: B352_SECRET_ENTRY_MECHANISM,
            dialog_opened: true,
            programmatic_clipboard_read: false,
            accepted_ascii_length: asString.length,
            format_valid: true,
          },
        };
      } finally {
        asString = "";
      }
    },
  };
}

export type SyntheticDialogAction = "continue" | "cancel" | "close";

/** Test-only dialog: no GUI, no clipboard. */
export function createSyntheticWindowsMaskedSecretDialog(input: {
  readonly credentialAscii?: string;
  readonly action?: SyntheticDialogAction;
}): WindowsMaskedSecretDialog & {
  readonly openCount: { value: number };
  readonly lastSafeMetadata: { length: number; format: "valid" | "invalid" } | null;
} {
  let opened = false;
  const openCount = { value: 0 };
  let lastSafeMetadata: { length: number; format: "valid" | "invalid" } | null = null;
  const action = input.action ?? "continue";

  return {
    mechanism: B352_SECRET_ENTRY_MECHANISM,
    openCount,
    get lastSafeMetadata() {
      return lastSafeMetadata;
    },
    async showOnce(_request) {
      if (opened) {
        throw new Error(
          `${BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT}: Windows masked secret dialog already opened`,
        );
      }
      opened = true;
      openCount.value += 1;
      if (action === "cancel") {
        assertB352SecretDialogCancelled("synthetic cancel");
      }
      if (action === "close") {
        assertB352SecretDialogClosed("synthetic close");
      }
      const value = input.credentialAscii ?? "";
      lastSafeMetadata = formatSafeKeyMetadata(value);
      if (!isValidPrivateKeyAscii(value)) {
        throw new Error(
          `${BLOCKED_B352_SECRET_DIALOG_INVALID}: synthetic credential failed structural validation`,
        );
      }
      const ascii = new Uint8Array(Buffer.from(value, "ascii"));
      return {
        credentialAscii: ascii,
        evidence: {
          mechanism: B352_SECRET_ENTRY_MECHANISM,
          dialog_opened: true,
          programmatic_clipboard_read: false,
          accepted_ascii_length: value.length,
          format_valid: true,
        },
      };
    },
  };
}

/**
 * Authorized one-shot Windows dialog entry → 32-byte credential.
 * Uses SecretEntryLedger (same one-shot contract as B.3.5 TTY).
 */
export async function readWindowsMaskedSecretDialog(input: {
  readonly authorization: AuthorizedSecretEntry;
  readonly dialog: WindowsMaskedSecretDialog;
  readonly ledger: SecretEntryLedger;
  readonly expectedWallet: string;
}): Promise<{
  readonly credentialBytes: Uint8Array;
  readonly evidence: WindowsMaskedSecretDialogResult["evidence"];
}> {
  if (input.authorization.__brand !== "AuthorizedSecretEntry") {
    throw new Error(
      `${BLOCKED_B352_SECRET_DIALOG_UNAUTHORIZED}: AuthorizedSecretEntry brand required`,
    );
  }
  if (input.dialog.mechanism !== B352_SECRET_ENTRY_MECHANISM) {
    throw new Error(
      `${BLOCKED_B352_SECRET_DIALOG_UNAUTHORIZED}: dialog mechanism mismatch`,
    );
  }

  const decisionId = input.authorization.decisionId;
  const unsignedHash = input.authorization.unsignedArtifactSha256;
  input.ledger.assertReserved(decisionId, unsignedHash);
  input.ledger.markInvoked(decisionId, unsignedHash);

  let ascii: Uint8Array | null = null;
  let credentialBytes: Uint8Array | null = null;
  try {
    const shown = await input.dialog.showOnce({
      expectedWallet: input.expectedWallet,
    });
    ascii = shown.credentialAscii;
    const asString = Buffer.from(ascii).toString("ascii");
    if (!isValidPrivateKeyAscii(asString)) {
      input.ledger.markConsumed(decisionId, unsignedHash);
      throw new Error(`${BLOCKED_B352_SECRET_DIALOG_INVALID}: structural validation failed`);
    }
    credentialBytes = privateKeyAsciiToCredentialBytes(asString);
    input.ledger.markConsumed(decisionId, unsignedHash);
    return { credentialBytes, evidence: shown.evidence };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes(BLOCKED_B352_SECRET_DIALOG_CANCELLED) ||
      message.includes(BLOCKED_B352_SECRET_DIALOG_CLOSED)
    ) {
      input.ledger.markAborted(decisionId, unsignedHash);
    } else if (message.includes(BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT)) {
      // leave ledger as-is / consumed path
    } else {
      input.ledger.markConsumed(decisionId, unsignedHash);
    }
    zeroCredentialBytes(credentialBytes);
    throw error;
  } finally {
    zeroCredentialBytes(ascii);
  }
}
