/**
 * buyer-hidden-tty-secret-entry — HIDDEN_PARENT_TTY_ONE_SHOT.
 *
 * Human → parent TTY (echo disabled, masked *) → mutable buffer → 32-byte credential.
 * Does not construct accounts, sign, or choose providers.
 * Does not access pasteboard APIs, argv, env, files, or shell.
 *
 * Windows note: classic conhost raw-mode Ctrl+V is control byte 0x16 (never credential
 * material). Host paste (Windows Terminal Ctrl+V, right-click, Shift+Insert) injects
 * hex characters into the TTY stream — those are accepted and masked with '*'.
 *
 * Deterministic secure erasure of all JS runtime copies is NOT guaranteed.
 */

import {
  BLOCKED_B351_PASTE_SHORTCUT_NOT_SUPPORTED,
  BLOCKED_B35_SECRET_ENTRY_INVALID,
  BLOCKED_B35_SECRET_ENTRY_OVERSIZED,
  BLOCKED_B35_SECRET_ENTRY_TIMEOUT,
  BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED,
  assertB35InteractiveTtyRequired,
  assertB35NoSecretEntryFallback,
  assertB35SecretEntryAborted,
} from "./b35-execution-gates";
import type { HiddenTtyTerminal } from "./buyer-hidden-tty-terminal";
import {
  type AuthorizedSecretEntry,
  type SecretEntryLedger,
} from "./buyer-secret-entry-authorization";
import { zeroCredentialBytes } from "./buyer-credential-transport-frame";

const KEY_CTRL_C = 0x03;
const KEY_ESCAPE = 0x1b;
const KEY_ENTER = 0x0d;
const KEY_LF = 0x0a;
const KEY_BACKSPACE = 0x7f;
const KEY_BS = 0x08;
/** Classic Windows raw-mode Ctrl+V — not a paste payload. */
const KEY_CTRL_V = 0x16;

/** Max ASCII chars: optional "0x" + 64 hex. */
export const B35_SECRET_ENTRY_MAX_ASCII = 66 as const;
export const B35_SECRET_ENTRY_MECHANISM = "HIDDEN_PARENT_TTY_ONE_SHOT" as const;

function isHexByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x61 && byte <= 0x66) ||
    (byte >= 0x41 && byte <= 0x46)
  );
}

export interface HiddenTtySecretEntryEvidence {
  mechanism: typeof B35_SECRET_ENTRY_MECHANISM;
  prompt_displayed: boolean;
  raw_mode_activations: number;
  raw_mode_restored: boolean;
  secret_bytes_read: number;
  /** Accepted credential ASCII length at submit (never the secret itself). */
  accepted_ascii_length: number;
  ctrl_v_control_bytes_ignored: number;
  masked_feedback_updates: number;
  credential_persisted: false;
  pasteboard_api_accessed: false;
}

export interface HiddenTtySecretEntryResult {
  readonly credentialBytes: Uint8Array;
  readonly evidence: HiddenTtySecretEntryEvidence;
}

function clearAsciiBuffer(buf: Uint8Array): void {
  buf.fill(0);
}

function renderMaskedPrompt(terminal: HiddenTtyTerminal, length: number): void {
  // \r + clear-to-EOL keeps the operator informed without echoing secrets.
  terminal.writeSafe(`\rPrivate key: ${"*".repeat(length)}\x1b[K`);
}

function bufferIsHexOnly(buf: Uint8Array, length: number): boolean {
  if (length === 0) return true;
  let offset = 0;
  if (length >= 2 && buf[0] === 0x30 && buf[1] === 0x78) {
    offset = 2;
  }
  for (let i = offset; i < length; i += 1) {
    if (!isHexByte(buf[i]!)) return false;
  }
  return true;
}

function formatStructuralRejectDiagnostics(input: {
  readonly length: number;
  readonly hexOnly: boolean;
  readonly ctrlVIgnored: number;
}): string {
  const lines = [
    "credential format rejected",
    `received character count: ${input.length}`,
    `hex-only: ${input.hexOnly ? "yes" : "no"}`,
  ];
  if (input.ctrlVIgnored > 0 && input.length === 0) {
    lines.push(
      `${BLOCKED_B351_PASTE_SHORTCUT_NOT_SUPPORTED}: Ctrl+V arrived as control byte 0x16 (not host paste text); use terminal-host paste (Windows Terminal Ctrl+V, right-click, or Shift+Insert)`,
    );
  }
  return lines.join("\n");
}

function asciiBufferToPrivateKeyBytes(buf: Uint8Array, length: number): Uint8Array {
  if (length !== 64 && length !== 66) {
    throw new Error(
      `${BLOCKED_B35_SECRET_ENTRY_INVALID}: private key must be exactly 64 hex chars or 0x + 64 hex chars`,
    );
  }
  let offset = 0;
  if (length === 66) {
    if (buf[0] !== 0x30 || buf[1] !== 0x78) {
      throw new Error(
        `${BLOCKED_B35_SECRET_ENTRY_INVALID}: only an exact 0x prefix is permitted when length is 66`,
      );
    }
    offset = 2;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    const hi = buf[offset + i * 2]!;
    const lo = buf[offset + i * 2 + 1]!;
    if (!isHexByte(hi) || !isHexByte(lo)) {
      throw new Error(
        `${BLOCKED_B35_SECRET_ENTRY_INVALID}: non-hex character in private key input`,
      );
    }
    out[i] = Number.parseInt(String.fromCharCode(hi, lo), 16);
  }
  return out;
}

function acceptInputByte(byte: number, length: number, first: number): boolean {
  if (isHexByte(byte)) return true;
  // Exact "0x" prefix only at positions 0 then 1.
  if (length === 0 && byte === 0x30) return true;
  if (length === 1 && first === 0x30 && (byte === 0x78 || byte === 0x58)) return true;
  return false;
}

/**
 * Read one hidden credential from an interactive TTY after authorization.
 * One-shot: no automatic re-prompt.
 */
export async function readHiddenParentTtySecret(input: {
  readonly authorization: AuthorizedSecretEntry;
  readonly terminal: HiddenTtyTerminal;
  readonly ledger: SecretEntryLedger;
  readonly timeoutMs?: number;
}): Promise<HiddenTtySecretEntryResult> {
  if (input.authorization.__brand !== "AuthorizedSecretEntry") {
    throw new Error(
      `${BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED}: AuthorizedSecretEntry brand required`,
    );
  }

  const decisionId = input.authorization.decisionId;
  const unsignedHash = input.authorization.unsignedArtifactSha256;
  input.ledger.assertReserved(decisionId, unsignedHash);
  input.ledger.markInvoked(decisionId, unsignedHash);

  if (!input.terminal.isTTY) {
    input.ledger.markAborted(decisionId, unsignedHash);
    assertB35InteractiveTtyRequired();
  }

  const evidence: HiddenTtySecretEntryEvidence = {
    mechanism: B35_SECRET_ENTRY_MECHANISM,
    prompt_displayed: false,
    raw_mode_activations: 0,
    raw_mode_restored: false,
    secret_bytes_read: 0,
    accepted_ascii_length: 0,
    ctrl_v_control_bytes_ignored: 0,
    masked_feedback_updates: 0,
    credential_persisted: false,
    pasteboard_api_accessed: false,
  };

  const priorRaw = input.terminal.getRawMode();
  const ascii = new Uint8Array(B35_SECRET_ENTRY_MAX_ASCII);
  let length = 0;
  let credentialBytes: Uint8Array | null = null;

  try {
    input.terminal.setRawMode(true);
    evidence.raw_mode_activations = 1;
    input.terminal.writeSafe(
      "Credential entry required.\n" +
        "Host paste injects hex into this prompt (masked as *). " +
        "Raw Ctrl+V control-byte is ignored — never treated as key material.\n" +
        "Private key: ",
    );
    evidence.prompt_displayed = true;

    while (true) {
      let byte: number | null;
      try {
        byte = await input.terminal.readByte(input.timeoutMs ?? 120_000);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.ledger.markAmbiguous(decisionId, unsignedHash);
        if (message.includes(BLOCKED_B35_SECRET_ENTRY_TIMEOUT) || /timed out/i.test(message)) {
          throw new Error(`${BLOCKED_B35_SECRET_ENTRY_TIMEOUT}: secret entry timed out`);
        }
        throw error;
      }

      if (byte === null) {
        input.ledger.markAmbiguous(decisionId, unsignedHash);
        throw new Error(`${BLOCKED_B35_SECRET_ENTRY_INVALID}: EOF during secret entry`);
      }

      evidence.secret_bytes_read += 1;

      if (byte === KEY_CTRL_C) {
        input.ledger.markAborted(decisionId, unsignedHash);
        assertB35SecretEntryAborted("Ctrl+C");
      }
      if (byte === KEY_ESCAPE) {
        input.ledger.markAborted(decisionId, unsignedHash);
        assertB35SecretEntryAborted("Escape");
      }
      if (byte === KEY_ENTER || byte === KEY_LF) {
        break;
      }
      if (byte === KEY_BACKSPACE || byte === KEY_BS) {
        if (length > 0) {
          length -= 1;
          ascii[length] = 0;
          renderMaskedPrompt(input.terminal, length);
          evidence.masked_feedback_updates += 1;
        }
        continue;
      }

      // Never append Ctrl+V (0x16) as credential material.
      if (byte === KEY_CTRL_V) {
        evidence.ctrl_v_control_bytes_ignored += 1;
        input.terminal.writeSafe(
          "\n[Ctrl+V was a control byte, not paste text — not added to the key. " +
            "Use host paste: Windows Terminal Ctrl+V, right-click, or Shift+Insert.]\n",
        );
        renderMaskedPrompt(input.terminal, length);
        evidence.masked_feedback_updates += 1;
        continue;
      }

      if (length >= B35_SECRET_ENTRY_MAX_ASCII) {
        input.ledger.markConsumed(decisionId, unsignedHash);
        throw new Error(
          `${BLOCKED_B35_SECRET_ENTRY_OVERSIZED}: secret entry exceeded ${B35_SECRET_ENTRY_MAX_ASCII} ASCII bytes`,
        );
      }

      const first = length > 0 ? ascii[0]! : 0;
      if (!acceptInputByte(byte, length, first)) {
        // Ignore noise (spaces, etc.); validate structure on Enter with sanitized diagnostics.
        continue;
      }

      ascii[length] = byte === 0x58 ? 0x78 : byte;
      length += 1;
      renderMaskedPrompt(input.terminal, length);
      evidence.masked_feedback_updates += 1;
    }

    evidence.accepted_ascii_length = length;

    try {
      credentialBytes = asciiBufferToPrivateKeyBytes(ascii, length);
    } catch (error) {
      input.ledger.markConsumed(decisionId, unsignedHash);
      const diagnostics = formatStructuralRejectDiagnostics({
        length,
        hexOnly: bufferIsHexOnly(ascii, length),
        ctrlVIgnored: evidence.ctrl_v_control_bytes_ignored,
      });
      try {
        input.terminal.writeSafe(`\n${diagnostics}\n`);
      } catch {
        // ignore
      }
      if (evidence.ctrl_v_control_bytes_ignored > 0 && length === 0) {
        throw new Error(
          `${BLOCKED_B351_PASTE_SHORTCUT_NOT_SUPPORTED}: Ctrl+V delivered control byte 0x16 only; no hex credential received`,
        );
      }
      const base = error instanceof Error ? error.message : String(error);
      throw new Error(`${base}\n${diagnostics}`);
    }

    input.ledger.markConsumed(decisionId, unsignedHash);
    input.terminal.writeSafe("\nCredential received.\n");
    return { credentialBytes, evidence };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.includes("BLOCKED_B35_SECRET_ENTRY_ABORTED") ||
        error.message.includes("BLOCKED_B35_INTERACTIVE_TTY_REQUIRED"))
    ) {
      try {
        input.terminal.writeSafe("\nCredential entry aborted.\n");
      } catch {
        // ignore
      }
    } else if (
      !(
        error instanceof Error &&
        (error.message.includes("credential format rejected") ||
          error.message.includes(BLOCKED_B351_PASTE_SHORTCUT_NOT_SUPPORTED))
      )
    ) {
      try {
        input.terminal.writeSafe("\nCredential rejected.\n");
      } catch {
        // ignore
      }
    }
    zeroCredentialBytes(credentialBytes);
    throw error;
  } finally {
    clearAsciiBuffer(ascii);
    try {
      input.terminal.setRawMode(priorRaw);
      evidence.raw_mode_restored = true;
    } catch {
      try {
        input.terminal.setRawMode(false);
        evidence.raw_mode_restored = true;
      } catch {
        evidence.raw_mode_restored = false;
      }
    }
  }
}

export function rejectSecretEntryFallback(): never {
  assertB35NoSecretEntryFallback();
}
