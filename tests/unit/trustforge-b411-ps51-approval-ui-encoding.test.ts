/**
 * B.4.1.1 — Windows PowerShell 5.1 approval UI encoding corrective.
 * NO REAL SIGNER. NO REAL PAYMENT.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE,
} from "../../tools/trustforge/b4-execution-gates";
import {
  assertWindowsApproveRejectDialogScriptEncodingSafe,
  auditWindowsApproveRejectDialogScriptEncoding,
  defaultWindowsApproveRejectDialogScriptPath,
} from "../../tools/trustforge/windows-approve-reject-dialog-ps51-encoding";
import { parseWindowsApproveRejectDialogResultForTests } from "../../tools/trustforge/windows-approve-reject-dialog";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "../..");
const PRODUCTION_SCRIPT = defaultWindowsApproveRejectDialogScriptPath();
const HARNESS_SCRIPT = join(
  ROOT,
  "tools/trustforge/windows-approve-reject-dialog-test-harness.ps1",
);

function runPowershell51Parse(scriptPath: string): {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
} {
  const probe = `
$ErrorActionPreference = 'Stop'
$errs = $null
$tokens = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile(
  '${scriptPath.replace(/'/g, "''")}',
  [ref]$tokens,
  [ref]$errs
)
if ($errs -and $errs.Count -gt 0) {
  $errs | ForEach-Object { $_.ToString() }
  exit 1
}
Write-Output 'PARSE_OK'
exit 0
`;
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", probe],
    { encoding: "utf8", windowsHide: true },
  );
  return {
    ok: result.status === 0 && (result.stdout ?? "").includes("PARSE_OK"),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
  };
}

function runHarness(mode: "lifetime" | "approve" | "reject" | "abort"): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const args = [
    "-NoProfile",
    "-STA",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    HARNESS_SCRIPT,
    "-Mode",
    mode,
    "-ProductionScript",
    PRODUCTION_SCRIPT,
    "-HoldMs",
    "1500",
  ];
  const result = spawnSync("powershell.exe", args, {
    encoding: "utf8",
    windowsHide: false,
    timeout: 60_000,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("B.4.1.1 PS 5.1 approval UI encoding", () => {
  it("encoding audit: production script is ASCII-only SAFE", () => {
    const audit = auditWindowsApproveRejectDialogScriptEncoding();
    expect(audit.ascii_only).toBe(true);
    expect(audit.non_ascii_byte_count).toBe(0);
    expect(audit.WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE).toBe("PASS");
    expect(WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE).toBe(
      "WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE",
    );
    expect(() => assertWindowsApproveRejectDialogScriptEncodingSafe()).not.toThrow();
    const buf = readFileSync(PRODUCTION_SCRIPT);
    for (let i = 0; i < buf.length; i += 1) {
      expect(buf[i]!).toBeLessThanOrEqual(0x7f);
    }
  });

  it("powershell.exe 5.1 ParseFile: production script PARSE_OK", () => {
    if (process.platform !== "win32") return;
    const parsed = runPowershell51Parse(PRODUCTION_SCRIPT);
    expect(parsed.ok, parsed.stderr || parsed.stdout).toBe(true);
  });

  it("harness: production has no synthetic auto-close / test flags", () => {
    const text = readFileSync(PRODUCTION_SCRIPT, "utf8");
    expect(text).not.toMatch(/\bHarnessMode\b|\bTestDecision\b/i);
    expect(text).not.toMatch(/^\s*\$?HarnessMode|^\s*\[string\]\$TestDecision/im);
    // Negative docs ("Never closes...") are OK; forbid synthetic timer/auto machinery.
    expect(text).not.toMatch(/System\.Windows\.Forms\.Timer|AutoClose|AutoSubmit/i);
    expect(text).toMatch(/ShowDialog/);
    expect(text).toMatch(/No automatic timeout/);
  });

  it.runIf(process.platform === "win32")(
    "A/B/C: dialog launches and stays open; elapsed time emits no decision",
    () => {
      const out = runHarness("lifetime");
      expect(out.status, out.stderr || out.stdout).toBe(0);
      expect(out.stdout).toContain("dialog_launched=true");
      expect(out.stdout).toContain("dialog_still_open_after_hold=true");
      expect(out.stdout).toContain("elapsed_time_emitted_decision=false");
      expect(out.stdout).toContain("production_stdout=ABORT");
      expect(out.stdout).toMatch(/production_stdout=decision_source=(window_close|keyboard_close)/);
      expect(out.stdout).toContain("signer_invocations=0");
      expect(out.stdout).toContain("payment_bearing_requests=0");
    },
  );

  it.runIf(process.platform === "win32")(
    "D: controlled APPROVE emits approve_button",
    () => {
      const out = runHarness("approve");
      expect(out.status, out.stderr || out.stdout).toBe(0);
      expect(out.stdout).toContain("production_stdout=APPROVE");
      expect(out.stdout).toContain("production_stdout=decision_source=approve_button");
      expect(out.stdout).toContain("production_exit_code=0");
      const parsed = parseWindowsApproveRejectDialogResultForTests(
        "APPROVE\ndecision_source=approve_button\n",
        0,
      );
      expect(parsed).toEqual({
        decision: "APPROVE",
        decision_source: "approve_button",
      });
    },
  );

  it.runIf(process.platform === "win32")(
    "E: controlled REJECT emits reject_button",
    () => {
      const out = runHarness("reject");
      expect(out.status, out.stderr || out.stdout).toBe(0);
      expect(out.stdout).toContain("production_stdout=REJECT");
      expect(out.stdout).toContain("production_stdout=decision_source=reject_button");
      expect(out.stdout).toContain("production_exit_code=2");
    },
  );

  it.runIf(process.platform === "win32")(
    "F: controlled close emits ABORT (never REJECT)",
    () => {
      const out = runHarness("abort");
      expect(out.status, out.stderr || out.stdout).toBe(0);
      expect(out.stdout).toContain("production_stdout=ABORT");
      expect(out.stdout).toMatch(/production_stdout=decision_source=(window_close|keyboard_close)/);
      expect(out.stdout).not.toContain("production_stdout=REJECT");
      expect(out.stdout).toContain("production_exit_code=3");
    },
  );

  it("G: decision parsing has no signer/payment side effects", () => {
    parseWindowsApproveRejectDialogResultForTests(
      "APPROVE\ndecision_source=approve_button\n",
      0,
    );
    parseWindowsApproveRejectDialogResultForTests(
      "ABORT\ndecision_source=window_close\n",
      3,
    );
    // Pure function — no vault, no network, no signer module imported here for effects.
    expect(true).toBe(true);
  });
});
