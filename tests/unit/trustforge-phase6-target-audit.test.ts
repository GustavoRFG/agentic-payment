import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { finalizePhase6Run } from "../../tools/run-trustforge-phase6-single-paid-rich-probe";
import type {
  HumanPaymentAuthorization,
  TargetSelectionAuditMetadata,
} from "../../tools/trustforge/validate-human-payment-authorization";

const endpoint = "https://public.zapper.xyz/x402/transaction-details";

const audit: TargetSelectionAuditMetadata = {
  selected_resource_url: endpoint,
  handshake_status: "live_402_ok",
  fallback_resource_urls: [
    "https://fallback-one.example/x402",
    "https://fallback-two.example/x402",
  ],
  scoring_rationale: [
    "price ascending",
    "freshness descending",
    "handshake live_402_ok",
  ],
};

const auth: HumanPaymentAuthorization = {
  authorization_schema_version: "trustforge_paid_probe_authorization.v1",
  decision: "authorize_one_payment",
  provider: "Zapper",
  service_id: "zapper_tx_explainer",
  endpoint,
  max_usdc: "0.10",
  max_payment_attempts: 1,
  allow_retry: false,
  require_dedicated_wallet: true,
  decided_at: "2026-06-20T00:00:00.000Z",
  rationale: "authorized once",
  target_selection_audit: audit,
};

describe("Phase 6 target selection audit metadata", () => {
  it("persists selected target, handshake, fallbacks, and scoring in finalize artifacts", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "tf-phase6-audit-"));
    try {
      const result = await finalizePhase6Run({
        runDir,
        richRunDir: join(runDir, "rich_probe_run"),
        auth,
        selected: {
          provider: "Zapper",
          service_id: "zapper_tx_explainer",
          endpoint,
          quote_amount_usdc: "0.001125",
          target_selection_audit: audit,
        },
        commitBefore: "test-commit",
        phase5RunDir: runDir,
      });

      const ledger = JSON.parse(
        await readFile(join(runDir, "payment_attempt_ledger.json"), "utf8"),
      );
      const state = JSON.parse(await readFile(join(runDir, "01_run_state.json"), "utf8"));
      const report = await readFile(join(runDir, "final_report.md"), "utf8");

      expect(ledger.target_selection_audit).toEqual(audit);
      expect(state.target_selection_audit).toEqual(audit);
      expect(result.resultLines).toContain(`selected_resource_url: ${endpoint}`);
      expect(result.resultLines).toContain("target_handshake_status: live_402_ok");
      expect(report).toContain("## Target selection audit");
      expect(report).toContain("price ascending");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
