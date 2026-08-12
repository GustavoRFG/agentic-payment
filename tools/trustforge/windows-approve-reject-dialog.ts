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
  GUARD_NO_APPROVAL_DIALOG_AUTO_TIMEOUT,
  GUARD_WINDOW_CLOSE_IS_ABORT_NOT_REJECT,
} from "./b4-execution-gates";
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

export function createWindowsApproveRejectDialogProvider(options?: {
  readonly scriptPath?: string;
  readonly powershellPath?: string;
}): HumanPaymentDecisionProvider {
  const scriptPath = options?.scriptPath ?? defaultScriptPath();
  const powershellPath = options?.powershellPath ?? "powershell.exe";
  let used = false;

  return {
    providerId: B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
    policy: B4_MANUAL_APPROVE_REJECT_POLICY,
    async decideOnce(candidate: PaymentApprovalCandidateView) {
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

      const decided_at = new Date().toISOString();
      const human_decision_id = `paydec_${randomUUID()}`;

      let stdout = "";
      let stderr = "";
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(
          powershellPath,
          [
            "-NoProfile",
            "-STA",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            scriptPath,
            "-ServiceLabel",
            candidate.service_label,
            "-NetworkLabel",
            candidate.network_label,
            "-Buyer",
            candidate.buyer,
            "-Seller",
            candidate.seller,
            "-AmountUsdc",
            candidate.amount_usdc,
            "-RequestSummary",
            candidate.request_summary,
          ],
          { windowsHide: false, stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.on("data", (c: Buffer) => {
          stdout += c.toString("utf8");
        });
        child.stderr.on("data", (c: Buffer) => {
          stderr += c.toString("utf8");
        });
        child.on("error", (error) => {
          reject(
            new Error(
              `${BLOCKED_B4_HUMAN_DECISION_UI_FAILED}: failed to spawn dialog (${error.message})`,
            ),
          );
        });
        // No timeout — ShowDialog must block until human interaction.
        child.on("close", (c) => resolve(c ?? 4));
      });

      void stderr;
      const parsed = parseDialogProcessOutput(stdout, code);
      const outcome: HumanPaymentDecisionOutcome = buildDecisionOutcome({
        decision: parsed.decision,
        decision_source: parsed.decision_source,
        human_decision_id,
        decided_at,
        provider_id: B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
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
