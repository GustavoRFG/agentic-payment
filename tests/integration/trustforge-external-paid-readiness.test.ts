import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  requestFromPaidPolicy,
  runExternalPaidProbe,
  writeExternalPaidReadinessArtifacts,
} from "../../tools/trustforge/external-x402-paid-executor";
import { ONESOURCE_ETHEREUM_CHAIN_ID_POLICY } from "../../tools/trustforge/external-x402-get-policy";
import type { ExternalHandshakeInspection } from "../../tools/trustforge/external-x402-get-adapter";

const POLICY = ONESOURCE_ETHEREUM_CHAIN_ID_POLICY;

function handshake(): ExternalHandshakeInspection {
  return {
    policyId: POLICY.policyId,
    serviceId: POLICY.serviceId,
    endpointUrl: POLICY.exactUrl,
    method: "GET",
    observedAtUtc: "2026-06-11T00:00:00.000Z",
    httpStatus: 402,
    contentType: "application/json",
    x402VersionObserved: "2",
    paymentRequirementsLocation: "header",
    observedTopLevelFields: ["accepts"],
    observedPaymentFields: ["amount", "network", "asset", "payTo"],
    scheme: "exact",
    network: "eip155:8453",
    asset: "USDC",
    assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    amountAtomic: "1000",
    quoteUsdc: "0.001",
    payTo: "0x52E29e0d2Aa49bfBfC548C0A9F2196F4aa51f3ea",
    maxTimeoutSeconds: 3600,
    resourceDescription: "Ethereum chain ID",
    offerReceiptExtensionAdvertised: false,
    redirectObserved: false,
    requestCount: 1,
    paymentAttempted: false,
    walletUsed: false,
    responseHeadersSanitized: {},
    responseBodySanitized: { error: "Payment required" },
    responseBodySha256: "abc",
    responseHeadersSha256: "def",
  };
}

describe("TrustForge external paid readiness integration", () => {
  it("runs readiness-only without wallet load, paid request, or payment headers", async () => {
    const inspectHandshake = vi.fn(async () => handshake());
    const verifyGroundTruth = vi.fn(async () => {
      throw new Error("should not run in readiness-only");
    });
    const loadWallet = vi.fn(async () => {
      throw new Error("wallet should not load in readiness-only");
    });
    const performPaidRequest = vi.fn(async () => {
      throw new Error("paid request should not run in readiness-only");
    });

    const result = await runExternalPaidProbe(
      {
        policy: POLICY,
        request: requestFromPaidPolicy(POLICY, {
          readinessOnly: true,
          executePaid: false,
          armingEnvValue: undefined,
        }),
        mode: "readiness-only",
      },
      {
        inspectHandshake,
        verifyGroundTruth,
        loadWallet,
        performPaidRequest,
      },
    );

    expect(result.status).toBe("PASS");
    expect(inspectHandshake).toHaveBeenCalledTimes(1);
    expect(verifyGroundTruth).not.toHaveBeenCalled();
    expect(loadWallet).not.toHaveBeenCalled();
    expect(performPaidRequest).not.toHaveBeenCalled();
    expect(result.paymentAttempts).toBe(0);
    expect(result.paymentHeadersSentLive).toBe(false);

    const runDir = mkdtempSync(join(tmpdir(), "trustforge-paid-readiness-"));
    await writeExternalPaidReadinessArtifacts(runDir, POLICY, result);
    for (const file of [
      "00_execution_log.md",
      "01_policy.json",
      "02_unpaid_handshake.json",
      "03_ground_truth_before.json",
      "04_arming_summary_sanitized.json",
      "05_wallet_summary_sanitized.json",
      "06_paid_request_summary_sanitized.json",
      "13_probe_run.json",
      "14_paid_smoke_report.md",
      "RESULT.txt",
    ]) {
      expect(existsSync(join(runDir, file))).toBe(true);
    }
  });
});
