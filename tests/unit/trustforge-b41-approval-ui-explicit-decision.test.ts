/**
 * B.4.1 — explicit payment approval decisions (synthetic only).
 * NO REAL SIGNER. NO REAL PAYMENT.
 */

import { describe, expect, it } from "vitest";

import {
  BLOCKED_B4_HUMAN_DECISION_ABORTED,
  BLOCKED_B4_HUMAN_REJECTED,
  GUARD_ONLY_EXPLICIT_BUTTON_PRODUCES_REJECT,
  GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT,
} from "../../tools/trustforge/b4-execution-gates";
import {
  assertOnlyExplicitButtonProducesReject,
  assertWindowCloseIsAbortNotReject,
  buildDecisionOutcome,
  createInjectedHumanPaymentDecisionProvider,
} from "../../tools/trustforge/human-payment-decision-provider";
import { parseWindowsApproveRejectDialogResultForTests } from "../../tools/trustforge/windows-approve-reject-dialog";
import {
  createRunnerState,
  transitionRunnerState,
} from "../../tools/trustforge/thin-mainnet-runner-state";

const NOW = new Date("2026-08-12T16:00:00.000Z");

describe("B.4.1 explicit approval decisions", () => {
  it("A/B: no decision emitted merely because time passes (injected holds until called)", async () => {
    let resolved = false;
    const provider = createInjectedHumanPaymentDecisionProvider(() => {
      resolved = true;
      return buildDecisionOutcome({
        decision: "APPROVE",
        decision_source: "approve_button",
        human_decision_id: "hold",
        decided_at: NOW.toISOString(),
        provider_id: "injected-test-decision",
      });
    });
    // Elapsed time without calling decideOnce must not invent a decision.
    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    const out = await provider.decideOnce({
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
    });
    expect(resolved).toBe(true);
    expect(out.decision).toBe("APPROVE");
    expect(out.explicit_human_decision).toBe(true);
  });

  it("C: APPROVE button → exact approve event", () => {
    const parsed = parseWindowsApproveRejectDialogResultForTests(
      "APPROVE\ndecision_source=approve_button\n",
      0,
    );
    expect(parsed).toEqual({
      decision: "APPROVE",
      decision_source: "approve_button",
    });
    const outcome = buildDecisionOutcome({
      ...parsed,
      human_decision_id: "a1",
      decided_at: NOW.toISOString(),
      provider_id: "test",
    });
    expect(outcome.explicit_human_decision).toBe(true);
  });

  it("D: REJECT button → exact reject event", () => {
    const parsed = parseWindowsApproveRejectDialogResultForTests(
      "REJECT\ndecision_source=reject_button\n",
      2,
    );
    expect(parsed.decision).toBe("REJECT");
    expect(parsed.decision_source).toBe("reject_button");
    assertOnlyExplicitButtonProducesReject("reject_button");
  });

  it("E: X / window close → ABORT, never REJECT", () => {
    const parsed = parseWindowsApproveRejectDialogResultForTests(
      "ABORT\ndecision_source=window_close\n",
      3,
    );
    expect(parsed.decision).toBe("ABORT");
    expect(parsed.decision_source).toBe("window_close");
    expect(parsed.decision).not.toBe("REJECT");
    assertWindowCloseIsAbortNotReject("ABORT", "window_close");
    expect(() =>
      buildDecisionOutcome({
        decision: "REJECT",
        decision_source: "window_close",
        human_decision_id: "bad",
        decided_at: NOW.toISOString(),
        provider_id: "test",
      }),
    ).toThrow(GUARD_ONLY_EXPLICIT_BUTTON_PRODUCES_REJECT);
  });

  it("keyboard Esc → ABORT (keyboard_close), never REJECT", () => {
    const parsed = parseWindowsApproveRejectDialogResultForTests(
      "ABORT\ndecision_source=keyboard_close\n",
      3,
    );
    expect(parsed).toEqual({
      decision: "ABORT",
      decision_source: "keyboard_close",
    });
  });

  it("legacy exit-3-without-token maps to ABORT not REJECT", () => {
    // Pre-B.4.1 misclassification: exit 3 became REJECT. Must not recur.
    const parsed = parseWindowsApproveRejectDialogResultForTests("CLOSED\n", 3);
    expect(parsed.decision).toBe("ABORT");
    expect(parsed.decision).not.toBe("REJECT");
  });

  it("runner states: ABORT / UI_FAILED are terminal and distinct from REJECT", () => {
    let record = createRunnerState("run_b41", NOW);
    record = transitionRunnerState(record, "CANDIDATE_READY", NOW);
    record = transitionRunnerState(record, "HUMAN_DECISION_PENDING", NOW);
    const aborted = transitionRunnerState(record, "HUMAN_DECISION_ABORTED", NOW, {
      human_decision_id: "abort1",
    });
    expect(aborted.state).toBe("HUMAN_DECISION_ABORTED");
    expect(aborted.state).not.toBe("HUMAN_REJECTED");

    let pending = createRunnerState("run_b41b", NOW);
    pending = transitionRunnerState(pending, "CANDIDATE_READY", NOW);
    pending = transitionRunnerState(pending, "HUMAN_DECISION_PENDING", NOW);
    const rejected = transitionRunnerState(pending, "HUMAN_REJECTED", NOW, {
      human_decision_id: "rej1",
    });
    expect(rejected.state).toBe("HUMAN_REJECTED");
  });

  it("F: no signer/payment side effects from decision parsing alone", () => {
    void GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT;
    expect(BLOCKED_B4_HUMAN_DECISION_ABORTED).toBe("BLOCKED_B4_HUMAN_DECISION_ABORTED");
    expect(BLOCKED_B4_HUMAN_REJECTED).toBe("BLOCKED_B4_HUMAN_REJECTED");
    // Parsing is pure — no network, no vault, no signer.
    parseWindowsApproveRejectDialogResultForTests(
      "ABORT\ndecision_source=window_close\n",
      3,
    );
  });
});
