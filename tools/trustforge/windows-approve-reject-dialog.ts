/**
 * windows-approve-reject-dialog — production HumanPaymentDecisionProvider.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
  B4_MANUAL_APPROVE_REJECT_POLICY,
  BLOCKED_B4_HUMAN_REJECTED,
} from "./b4-execution-gates";
import type {
  HumanPaymentDecisionOutcome,
  HumanPaymentDecisionProvider,
  PaymentApprovalCandidateView,
} from "./human-payment-decision-provider";

function defaultScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "windows-approve-reject-dialog.ps1");
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
        throw new Error(`${BLOCKED_B4_HUMAN_REJECTED}: decision dialog already used`);
      }
      used = true;
      if (process.platform !== "win32") {
        throw new Error(`${BLOCKED_B4_HUMAN_REJECTED}: approve/reject dialog requires win32`);
      }

      const decided_at = new Date().toISOString();
      const human_decision_id = `paydec_${randomUUID()}`;

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
        child.on("error", reject);
        child.on("close", (c) => resolve(c ?? 1));
      });

      if (code === 0) {
        const outcome: HumanPaymentDecisionOutcome = {
          decision: "APPROVE",
          human_decision_id,
          decided_at,
          provider_id: B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
          policy: B4_MANUAL_APPROVE_REJECT_POLICY,
        };
        return outcome;
      }
      const reason = code === 2 ? "rejected" : "closed";
      return {
        decision: "REJECT",
        human_decision_id,
        decided_at,
        provider_id: B4_APPROVE_REJECT_DECISION_PROVIDER_ID,
        policy: B4_MANUAL_APPROVE_REJECT_POLICY,
        reason,
      };
    },
  };
}
