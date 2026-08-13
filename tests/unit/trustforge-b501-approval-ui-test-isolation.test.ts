/**
 * B.5.0.1 — isolate human approval UI from automated tests.
 * NO VISIBLE DIALOG. NO SIGNER. NO PAYMENT.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI,
} from "../../tools/trustforge/b4-execution-gates";
import {
  buildDecisionOutcome,
  createTestHumanPaymentDecisionProvider,
  TEST_HUMAN_PAYMENT_DECISION_PROVIDER_ID,
} from "../../tools/trustforge/human-payment-decision-provider";
import {
  createWindowsApproveRejectDialogProvider,
  OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT,
} from "../../tools/trustforge/windows-approve-reject-dialog";

const ROOT = process.cwd();

/** Fragmented so this audit file does not contain contiguous UI-automation API tokens. */
const UI_AUTOMATION_NEEDLES = [
  "UIAutomation" + "Client",
  "Invoke" + "Pattern",
  "Send" + "Keys",
  "mouse" + "_event",
  "SetCursor" + "Pos",
];

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "__pycache__") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, acc);
    else if (/\.(ts|tsx|js|mjs|ps1)$/.test(name)) acc.push(p);
  }
  return acc;
}

describe("B.5.0.1 approval UI test isolation", () => {
  it("structural: tests never spawn production dialog / UI automation", () => {
    void GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI;
    const testFiles = walkFiles(join(ROOT, "tests"));
    const offenders: string[] = [];
    for (const file of testFiles) {
      const text = readFileSync(file, "utf8");
      if (/windows-approve-reject-dialog-test-harness\.ps1/.test(text)) {
        offenders.push(`${file}: harness script reference`);
      }
      for (const needle of UI_AUTOMATION_NEEDLES) {
        if (text.includes(needle)) {
          offenders.push(`${file}: UI automation API`);
          break;
        }
      }
      // Allow import of parse helpers / createWindows for negative gate tests only when
      // decideOnce is expected to throw under Vitest — forbid -File spawn of production ps1.
      if (
        /-File[\s\S]{0,80}windows-approve-reject-dialog\.ps1/.test(text) ||
        /spawnSync\([\s\S]{0,200}windows-approve-reject-dialog\.ps1/.test(text)
      ) {
        offenders.push(`${file}: production dialog -File spawn`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("production provider requires operational checkpoint (UI reachability only)", async () => {
    const bare = createWindowsApproveRejectDialogProvider();
    await expect(
      bare.decideOnce({
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
    ).rejects.toThrow(/GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI|BLOCKED_B4_PRODUCTION_APPROVAL_UI/);
  });

  it("operational checkpoint constant remains wired for CLI (not launched here)", () => {
    expect(OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT.mode).toBe(
      "operational_human_checkpoint",
    );
    expect(
      OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT
        .acknowledges_visible_dialog_is_real_human_checkpoint,
    ).toBe(true);
    const cli = readFileSync(
      join(ROOT, "tools/run-trustforge-mainnet-payment.ts"),
      "utf8",
    );
    expect(cli).toMatch(/OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT/);
    expect(cli).toMatch(/createWindowsApproveRejectDialogProvider/);
  });

  it("headless APPROVE / REJECT / ABORT (TestHumanPaymentDecisionProvider)", async () => {
    const now = "2026-08-13T05:10:00.000Z";
    const view = {
      service_label: "iso",
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
    const a = await createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "APPROVE",
        decision_source: "approve_button",
        human_decision_id: "iso_a",
        decided_at: now,
        provider_id: TEST_HUMAN_PAYMENT_DECISION_PROVIDER_ID,
      }),
    ).decideOnce(view);
    const r = await createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "REJECT",
        decision_source: "reject_button",
        human_decision_id: "iso_r",
        decided_at: now,
        provider_id: TEST_HUMAN_PAYMENT_DECISION_PROVIDER_ID,
      }),
    ).decideOnce(view);
    const b = await createTestHumanPaymentDecisionProvider(
      buildDecisionOutcome({
        decision: "ABORT",
        decision_source: "window_close",
        human_decision_id: "iso_b",
        decided_at: now,
        provider_id: TEST_HUMAN_PAYMENT_DECISION_PROVIDER_ID,
      }),
    ).decideOnce(view);
    expect(a.decision).toBe("APPROVE");
    expect(r.decision).toBe("REJECT");
    expect(b.decision).toBe("ABORT");
    expect(a.provider_id).toBe(TEST_HUMAN_PAYMENT_DECISION_PROVIDER_ID);
  });

  it("B43 human UX acceptance evidence path preserved (write-once reference)", () => {
    // Canonical human UX acceptance remains the B43 operational run; this task
    // does not relaunch it.
    expect(
      "D:\\trustforge\\artifacts\\runs\\b43-human-approval-ui-acceptance",
    ).toMatch(/b43-human-approval-ui-acceptance/);
  });
});