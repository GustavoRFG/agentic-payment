import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RiskReportRequest } from "../../seller-api/src/adapters/defi-guardian/reportTypes";
import { startSeller, type SellerHarness } from "../../tools/_lib/seller-harness";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

export function tempAuditLogDir(): string {
  return mkdtempSync(join(tmpdir(), "agentic-payments-lab-test-logs-"));
}

export function fixtureSnapshotPath(): string {
  return join(
    projectRoot(),
    "seller-api",
    "src",
    "adapters",
    "defi-guardian",
    "defiGuardianSnapshotV1.sample.json",
  );
}

export function validRequest(tokenId = "demo-position-001"): RiskReportRequest {
  return {
    wallet: ZERO_ADDRESS,
    position: {
      protocol: "pancakeswap",
      chain: "bsc",
      tokenId,
      pair: "CAKE/BNB",
      rangeStatus: "near_edge",
      liquidityUsd: 420,
      feesUsd: 3.42,
      impermanentLossEstimatePct: 3.4,
      healthFlags: ["manual-review"],
    },
  };
}

export async function startTestSeller(options: {
  adapterMode?: "mock" | "real-file";
  snapshotPath?: string;
} = {}): Promise<SellerHarness> {
  return startSeller({
    projectRoot: projectRoot(),
    auditLogDir: tempAuditLogDir(),
    ...options,
  });
}
