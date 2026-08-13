/**
 * windows-approve-reject-dialog — production HumanPaymentDecisionProvider (B.4.1).
 *
 * APPROVE/REJECT only from explicit button clicks.
 * Window X / Esc → ABORT (never REJECT).
 * No automatic timeout / auto-close / auto-submit.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
  B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
  B4_MANUAL_APPROVE_REJECT_POLICY,
  BLOCKED_B4_HUMAN_DECISION_UI_FAILED,
  BLOCKED_B4_PRODUCTION_APPROVAL_UI_WITHOUT_OPERATIONAL_CONTEXT,
  GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI,
  GUARD_NO_APPROVAL_DIALOG_AUTO_TIMEOUT,
  GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT,
} from "./b4-execution-gates";
import { GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT } from "./b52-execution-gates";
import {
  buildDecisionOutcome,
  type HumanPaymentDecisionKind,
  type HumanPaymentDecisionOutcome,
  type HumanPaymentDecisionProvider,
  type HumanPaymentDecisionSource,
  type PaymentApprovalCandidateView,
} from "./human-payment-decision-provider";
import {
  assertWindowsApproveRejectDialogScriptEncodingSafe,
  defaultWindowsApproveRejectDialogScriptPath,
} from "./windows-approve-reject-dialog-ps51-encoding";

function defaultScriptPath(): string {
  return defaultWindowsApproveRejectDialogScriptPath();
}

function parseDialogProcessOutput(stdout: string, exitCode: number): {
  readonly decision: HumanPaymentDecisionKind;
  readonly decision_source: HumanPaymentDecisionSource;
} {
  void GUARD_NO_APPROVAL_DIALOG_AUTO_TIMEOUT;
  void GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT;

  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const token = lines.find((l) =>
    ["APPROVE", "REJECT", "ABORT", "UI_FAILED"].includes(l),
  );
  const sourceLine = lines.find((l) => l.startsWith("decision_source="));
  const sourceRaw = sourceLine?.slice("decision_source=".length) ?? null;

  if (exitCode === 0 || token === "APPROVE") {
    return { decision: "APPROVE", decision_source: "approve_button" };
  }
  if (exitCode === 2 || token === "REJECT") {
    // REJECT only if script attested reject_button (defense in depth).
    if (sourceRaw && sourceRaw !== "reject_button") {
      throw new Error(
        `${GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT}: REJECT exit without reject_button source`,
      );
    }
    return { decision: "REJECT", decision_source: "reject_button" };
  }
  if (exitCode === 3 || token === "ABORT") {
    const src: HumanPaymentDecisionSource =
      sourceRaw === "keyboard_close" ? "keyboard_close" : "window_close";
    return { decision: "ABORT", decision_source: src };
  }
  return { decision: "UI_FAILED", decision_source: "ui_failure" };
}

/**
 * Explicit operational context required to show the visible production dialog.
 * This is UI-reachability only — it does NOT authorize payment.
 * Automated tests must never construct or pass this object.
 */
export const OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT = {
  mode: "operational_human_checkpoint",
  acknowledges_visible_dialog_is_real_human_checkpoint: true,
} as const;

export type OperationalHumanApprovalUiCheckpoint =
  typeof OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT;

function assertOperationalHumanApprovalUiAllowed(
  checkpoint: OperationalHumanApprovalUiCheckpoint | undefined,
): void {
  void GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI;
  // Vitest / NODE_ENV=test: hard-block visible production UI.
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    throw new Error(
      `${GUARD_AUTOMATED_TESTS_CANNOT_INVOKE_PRODUCTION_APPROVAL_UI}: visible production Approve/Reject UI cannot run under automated tests`,
    );
  }
  if (
    !checkpoint ||
    checkpoint.mode !== "operational_human_checkpoint" ||
    checkpoint.acknowledges_visible_dialog_is_real_human_checkpoint !== true
  ) {
    throw new Error(
      `${BLOCKED_B4_PRODUCTION_APPROVAL_UI_WITHOUT_OPERATIONAL_CONTEXT}: production approval UI requires OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT (not payment authorization)`,
    );
  }
}

export function createWindowsApproveRejectDialogProvider(options?: {
  readonly scriptPath?: string;
  readonly powershellPath?: string;
  /**
   * Required for any visible dialog launch. Operational CLI must pass
   * OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT. Tests must use
   * createTestHumanPaymentDecisionProvider instead.
   */
  readonly operationalHumanCheckpoint?: OperationalHumanApprovalUiCheckpoint;
}): HumanPaymentDecisionProvider {
  const scriptPath = options?.scriptPath ?? defaultScriptPath();
  const powershellPath = options?.powershellPath ?? "powershell.exe";
  const checkpoint = options?.operationalHumanCheckpoint;
  let used = false;

  return {
    providerId: B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
    policy: B4_MANUAL_APPROVE_REJECT_POLICY,
    async decideOnce(candidate: PaymentApprovalCandidateView) {
      // Gate before any spawn — tests never reach PowerShell UI.
      assertOperationalHumanApprovalUiAllowed(checkpoint);

      if (used) {
        throw new Error(
          `${BLOCKED_B4_HUMAN_DECISION_UI_FAILED}: decision dialog already used`,
        );
      }
      used = true;
      if (process.platform !== "win32") {
        throw new Error(
          `${BLOCKED_B4_HUMAN_DECISION_UI_FAILED}: approve/reject dialog requires win32`,
        );
      }

      // Fail closed before spawn if the launcher is not PS 5.1-safe.
      assertWindowsApproveRejectDialogScriptEncodingSafe(scriptPath);

      // B.5.2: operational UI must render authoritative PaymentApprovalIntent projection.
      if (candidate.ui_source === "authoritative_PaymentApprovalIntent") {
        void GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT;
        if (!candidate.payment_approval_intent_hash) {
          throw new Error(
            `${GUARD_OPERATIONAL_UI_RENDERS_AUTHORITATIVE_PAYMENT_INTENT}: missing payment_approval_intent_hash`,
          );
        }
      }

      const decided_at = new Date().toISOString();
      const human_decision_id = `paydec_${randomUUID()}`;

      const psArgs = [
        "-NoProfile",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-ServiceLabel",
        candidate.service_label,
        "-NetworkLabel",
        candidate.network_label === "eip155:8453" ? "Base" : candidate.network_label,
        "-Buyer",
        candidate.buyer,
        "-Seller",
        candidate.seller,
        "-AmountUsdc",
        candidate.amount_usdc,
        "-RequestSummary",
        candidate.request_summary,
      ];
      if (candidate.dialog_title) {
        psArgs.push("-DialogTitle", candidate.dialog_title);
      }
      if (candidate.method) {
        psArgs.push("-Method", candidate.method);
      }
      if (candidate.advertised_purpose) {
        psArgs.push("-AdvertisedPurpose", candidate.advertised_purpose);
      }
      if (candidate.purpose_quality_note) {
        psArgs.push("-PurposeQualityNote", candidate.purpose_quality_note);
      }
      if (candidate.why_selected) {
        psArgs.push("-WhySelected", candidate.why_selected);
      }
      if (candidate.known_facts?.length) {
        psArgs.push("-KnownFacts", candidate.known_facts.map((f) => `- ${f}`).join("\n"));
      }
      if (candidate.unknown_facts?.length) {
        psArgs.push("-UnknownFacts", candidate.unknown_facts.map((f) => `- ${f}`).join("\n"));
      }
      if (candidate.payment_approval_intent_hash) {
        psArgs.push("-IntentHash", candidate.payment_approval_intent_hash);
      }

      let stdout = "";
      let stderr = "";
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(powershellPath, psArgs, {
          windowsHide: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let settled = false;
        const finish = (exit: number, error?: Error) => {
          if (settled) return;
          settled = true;
          // Drain/destroy stdio before process teardown. Leaving closing pipe
          // handles around until process.exit can trip libuv UV_HANDLE_CLOSING
          // asserts on Windows (observed EXITCODE -1073740791 after success).
          try {
            child.stdout?.removeAllListeners();
            child.stderr?.removeAllListeners();
            child.removeAllListeners();
            child.stdout?.destroy();
            child.stderr?.destroy();
          } catch {
            // ignore destroy races
          }
          if (error) reject(error);
          else resolve(exit);
        };
        child.stdout.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });
        child.stderr.on("data", (c: Buffer) => {
          stderr += c.toString("utf8");
        });
        child.on("error", (error) => {
          finish(
            4,
            new Error(
              `${BLOCKED_B4_HUMAN_DECISION_UI_FAILED}: failed to spawn dialog (${error.message})`,
            ),
          );
        });
        // No timeout — ShowDialog must block until human interaction.
        child.on("close", (c) => finish(c ?? 4));
      });

      void stderr;
      const parsed = parseDialogProcessOutput(stdout, code);
      const outcome: HumanPaymentDecisionOutcome = buildDecisionOutcome({
        decision: parsed.decision,
        decision_source: parsed.decision_source,
        human_decision_id,
        decided_at,
        provider_id: B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
        payment_approval_intent_hash: candidate.payment_approval_intent_hash,
        bound_method: candidate.method,
      });
      return outcome;
    },
  };
}

/** Test-only: parse script stdout/exit without spawning GUI. */
export function parseWindowsApproveRejectDialogResultForTests(
  stdout: string,
  exitCode: number,
): ReturnType<typeof parseDialogProcessOutput> {
  return parseDialogProcessOutput(stdout, exitCode);
}
