/**
 * windows-approve-reject-dialog-ps51-encoding — B.4.1.1 encoding guard.
 *
 * Ensures the production Approve/Reject PowerShell launcher is safely
 * consumable by Windows PowerShell 5.1 (legacy code-page parse of -File).
 * Preferred: ASCII-only source (no UTF-8 typography without BOM).
 *
 * NO PAYMENT. NO SIGNER.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCKED_B4_HUMAN_DECISION_UI_FAILED,
  GUARD_APPROVAL_SCRIPT_MUST_BE_PS51_SAFE,
  WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE,
} from "./b4-execution-gates";

export {
  GUARD_APPROVAL_SCRIPT_MUST_BE_PS51_SAFE,
  WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE,
};

export interface ApprovalDialogScriptEncodingAudit {
  readonly script_path: string;
  readonly byte_length: number;
  readonly has_utf8_bom: boolean;
  readonly non_ascii_byte_count: number;
  readonly non_ascii_offsets: readonly number[];
  readonly ascii_only: boolean;
  readonly WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE:
    | "PASS"
    | "FAIL";
  readonly reason: string;
}

export function defaultWindowsApproveRejectDialogScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "windows-approve-reject-dialog.ps1");
}

export function auditWindowsApproveRejectDialogScriptEncoding(
  scriptPath: string = defaultWindowsApproveRejectDialogScriptPath(),
): ApprovalDialogScriptEncodingAudit {
  const buf = readFileSync(scriptPath);
  const hasBom =
    buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const start = hasBom ? 3 : 0;
  const nonAsciiOffsets: number[] = [];
  for (let i = start; i < buf.length; i += 1) {
    if (buf[i]! > 0x7f) {
      nonAsciiOffsets.push(i);
      if (nonAsciiOffsets.length >= 32) break;
    }
  }
  let nonAsciiCount = nonAsciiOffsets.length;
  if (nonAsciiOffsets.length >= 32) {
    nonAsciiCount = 0;
    for (let i = start; i < buf.length; i += 1) {
      if (buf[i]! > 0x7f) nonAsciiCount += 1;
    }
  }
  const asciiOnly = nonAsciiCount === 0;
  // Preferred: ASCII-only. UTF-8+BOM with non-ASCII is accepted only when
  // intentional; this production launcher must stay ASCII-only.
  const safe: "PASS" | "FAIL" = asciiOnly ? "PASS" : "FAIL";
  return {
    script_path: scriptPath,
    byte_length: buf.length,
    has_utf8_bom: hasBom,
    non_ascii_byte_count: nonAsciiCount,
    non_ascii_offsets: nonAsciiOffsets,
    ascii_only: asciiOnly,
    WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE: safe,
    reason: asciiOnly
      ? "ASCII-only productive approval launcher; safe for Windows PowerShell 5.1 -File parse"
      : "non-ASCII bytes present; Windows PowerShell 5.1 may mis-decode without BOM",
  };
}

export function assertWindowsApproveRejectDialogScriptEncodingSafe(
  scriptPath?: string,
): ApprovalDialogScriptEncodingAudit {
  const audit = auditWindowsApproveRejectDialogScriptEncoding(scriptPath);
  if (audit.WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE !== "PASS") {
    throw new Error(
      `${BLOCKED_B4_HUMAN_DECISION_UI_FAILED}: ${GUARD_APPROVAL_SCRIPT_MUST_BE_PS51_SAFE}: ${audit.reason}`,
    );
  }
  return audit;
}
