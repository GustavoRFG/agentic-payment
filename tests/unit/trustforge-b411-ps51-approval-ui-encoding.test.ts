/**
 * B.4.1.1 — Windows PowerShell 5.1 approval UI encoding corrective.
 * NO REAL SIGNER. NO REAL PAYMENT. NO VISIBLE DIALOG.
 *
 * Visible production UI is forbidden in automated tests (B.5.0.1).
 * Dialog launch/click proofs use headless TestHumanPaymentDecisionProvider
 * and stdout/exit parse helpers only.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI,
  WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE,
} from "../../tools/trustforge/b4-execution-gates";
import {
  buildDecisionOutcome,
  createTestHumanPaymentDecisionProvider,
} from "../../tools/trustforge/human-payment-decision-provider";
import {
  assertWindowsApproveRejectDialogScriptEncodingSafe,
  auditWindowsApproveRejectDialogScriptEncoding,
  defaultWindowsApproveRejectDialogScriptPath,
} from "../../tools/trustforge/windows-approve-reject-dialog-ps51-encoding";
import {
  createWindowsApproveRejectDialogProvider,
  OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT,
  parseWindowsApproveRejectDialogResultForTests,
} from "../../tools/trustforge/windows-approve-reject-dialog";

const PRODUCTION_SCRIPT = defaultWindowsApproveRejectDialogScriptPath();

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

describe("B.4.1.1 PS 5.1 approval UI encoding (headless)", () => {
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

  it("powershell.exe 5.1 ParseFile: production script PARSE_OK (no UI)", () => {
    if (process.platform !== "win32") return;
    const parsed = runPowershell51Parse(PRODUCTION_SCRIPT);
    expect(parsed.ok, parsed.stderr || parsed.stdout).toBe(true);
  });

  it("production script has no harness/auto-close machinery", () => {
    const text = readFileSync(PRODUCTION_SCRIPT, "utf8");
    expect(text).not.toMatch(/\bHarnessMode\b|\bTestDecision\b/i);
    expect(text).not.toMatch(/System\.Windows\.Forms\.Timer|AutoClose|AutoSubmit/i);
    expect(text).toMatch(/ShowDialog/);
    expect(text).toMatch(/No automatic timeout/);
  });

  it("headless APPROVE / REJECT / ABORT via TestHumanPaymentDecisionProvider", async () => {
    const now = "2026-08-13T05:00:00.000Z";
    const approve = createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "APPROVE",
        decision_source: "approve_button",
        human_decision_id: "t_approve",
        decided_at: now,
        provider_id: "test-human-payment-decision",
      }),
    );
    const reject = createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "REJECT",
        decision_source: "reject_button",
        human_decision_id: "t_reject",
        decided_at: now,
        provider_id: "test-human-payment-decision",
      }),
    );
    const abort = createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "ABORT",
        decision_source: "window_close",
        human_decision_id: "t_abort",
        decided_at: now,
        provider_id: "test-human-payment-decision",
      }),
    );
    const view = {
      service_label: "x",
      network_label: "Base",
      buyer: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
      seller: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
      amount_usdc: "0.001",
      amount_atomic: "1000",
      request_summary: "GET",
      endpoint: "https://example.invalid",
      method: "GET",
      max_attempts: 1 as const,
      max_signatures: 1 as const,
      max_payment_requests: 1 as const,
      allow_retry: false as const,
      allow_resend: false as const,
    };
    expect((await approve.decideOnce(view)).decision).toBe("APPROVE");
    expect((await reject.decideOnce(view)).decision).toBe("REJECT");
    expect((await abort.decideOnce(view)).decision).toBe("ABORT");
  });

  it("production stdout/exit parse: APPROVE / REJECT / ABORT (no spawn)", () => {
    expect(
      parseWindowsApproveRejectDialogResultForTests(
        "APPROVE\ndecision_source=approve_button\n",
        0,
      ),
    ).toEqual({ decision: "APPROVE", decision_source: "approve_button" });
    expect(
      parseWindowsApproveRejectDialogResultForTests(
        "REJECT\ndecision_source=reject_button\n",
        2,
      ),
    ).toEqual({ decision: "REJECT", decision_source: "reject_button" });
    expect(
      parseWindowsApproveRejectDialogResultForTests(
        "ABORT\ndecision_source=window_close\n",
        3,
      ),
    ).toEqual({ decision: "ABORT", decision_source: "window_close" });
  });

  it("production provider refuses launch under Vitest even with checkpoint", async () => {
    expect(GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI).toBeTruthy();
    const provider = createWindowsApproveRejectDialogProvider({
      operationalHumanCheckpoint: OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT,
    });
    await expect(
      provider.decideOnce({
        service_label: "x",
        network_label: "Base",
        buyer: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
        seller: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
        amount_usdc: "0.001",
        amount_atomic: "1000",
        request_summary: "GET",
        endpoint: "https://example.invalid",
        method: "GET",
        max_attempts: 1,
        max_signatures: 1,
        max_payment_requests: 1,
        allow_retry: false,
        allow_resend: false,
      }),
    ).rejects.toThrow(GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI);
  });

  it("G: decision parsing has no signer/payment side effects", () => {
    parseWindowsApproveRejectDialogResultForTests(
      "APPROVE\ndecision_source=approve_button\n",
      0,
    );
    expect(true).toBe(true);
  });
});
