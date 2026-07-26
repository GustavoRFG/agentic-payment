import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runX402PaidSettlement } from "../../tools/trustforge/x402-paid-settlement-runner";
import { MAINNET_X402_SETTLEMENT_PROFILE } from "../../tools/trustforge/x402-settlement-profile";

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), "settle-runner-"));
  writeFileSync(
    join(runDir, "human_payment_authorization.json"),
    JSON.stringify({
      authorization_schema_version: "1",
      decision: "approve",
      provider: "discovered_x402",
      service_id: "svc",
      endpoint: "https://seller.example/x402",
      max_usdc: "0.01",
      max_payment_attempts: 1,
      allow_retry: false,
    }),
  );
  writeFileSync(
    join(runDir, "selected_candidate.json"),
    JSON.stringify({ endpoint: "https://seller.example/x402", network: "eip155:8453" }),
  );
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe("settle runner — structured RESULT for a BLOCKED_* throw (C)", () => {
  it("captures BLOCKED_PAY_TIME_FRESHNESS and emits a structured RESULT instead of a raw throw", async () => {
    const { exitCode, lines } = await runX402PaidSettlement({
      runDir,
      profile: MAINNET_X402_SETTLEMENT_PROFILE,
      executeImpl: async () => {
        throw new Error("BLOCKED_PAY_TIME_FRESHNESS: quote issued_at older than freshness window");
      },
    });

    expect(exitCode).toBe(1);
    expect(lines[0]).toBe("RESULT");
    expect(lines).toContain("x402_settlement_execution_status: BLOCKED_PAY_TIME_FRESHNESS");
    expect(lines).toContain("payment_attempted: no");
    expect(lines).toContain("blocked_reason: BLOCKED_PAY_TIME_FRESHNESS");
    expect(lines.some((l) => l.startsWith("blocked_detail: quote issued_at older"))).toBe(true);

    const resultTxt = readFileSync(join(runDir, "settlement_probe", "RESULT.txt"), "utf8");
    expect(resultTxt).toContain("BLOCKED_PAY_TIME_FRESHNESS");
    // No execution record is written for a blocked (never-attempted) settlement.
    expect(existsSync(join(runDir, "settlement_probe", "01_execution.json"))).toBe(false);
  });

  it("re-throws genuinely unexpected (non-BLOCKED) errors", async () => {
    mkdirSync(join(runDir, "settlement_probe"), { recursive: true });
    await expect(
      runX402PaidSettlement({
        runDir,
        profile: MAINNET_X402_SETTLEMENT_PROFILE,
        executeImpl: async () => {
          throw new Error("ECONNRESET: socket hang up");
        },
      }),
    ).rejects.toThrow(/ECONNRESET/);
  });
});
