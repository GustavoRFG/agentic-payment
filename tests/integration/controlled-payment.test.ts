import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import {
  MAINNET_NETWORKS,
  sanitizeEnv,
} from "../../seller-api/src/config/safety";
import {
  MAX_PAYMENT_ATTEMPTS,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  TESTNET_NETWORK,
} from "../../shared/payment-safety";
import {
  forbiddenSnapshotPath,
  parseDefiGuardianSnapshotV1Json,
  type DefiGuardianSnapshotPositionV1,
} from "../../seller-api/src/domain/defiGuardianSnapshotV1";
import type { RiskReportRequest } from "../../seller-api/src/domain/reportTypes";
import type { SellerHarness } from "../../tools/_lib/seller-harness";
import { projectRoot, startTestSeller, ZERO_ADDRESS } from "./_helpers";

const enabled =
  process.env.ENABLE_CONTROLLED_PAYMENT === "1" &&
  process.env.CONTROLLED_PAYMENT_CONFIRMATION === "ONE_BASE_SEPOLIA_PAYMENT";

const WRAPPER_PAYMENT_INVOCATIONS = 1 as const;
const describeControlled = enabled ? describe : describe.skip;

interface AcceptEntry {
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  extra?: { name?: string };
}

function snapshotPath(): string {
  return resolve(projectRoot(), "runtime", "defi-guardian-snapshots", "latest.json");
}

function loadSnapshotAndSelectActivePosition(): {
  generatedAt: string;
  positions: number;
  selected: DefiGuardianSnapshotPositionV1;
} {
  const file = snapshotPath();
  expect(forbiddenSnapshotPath(file)).toBeNull();
  expect(existsSync(file)).toBe(true);

  const parsed = parseDefiGuardianSnapshotV1Json(readFileSync(file, "utf8"));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("local sanitized snapshot is invalid");

  const selected = parsed.snapshot.positions.find((position) => position.inRange === true);
  expect(selected).toBeTruthy();
  if (!selected) throw new Error("local sanitized snapshot has no active position");

  return {
    generatedAt: parsed.snapshot.generatedAt,
    positions: parsed.snapshot.positions.length,
    selected,
  };
}

function requestFor(position: DefiGuardianSnapshotPositionV1): RiskReportRequest {
  return {
    wallet: ZERO_ADDRESS,
    position: {
      protocol: position.protocol,
      chain: position.chain,
      tokenId: position.tokenId,
      pair: position.pair,
    },
  };
}

function atomicUsdcToUsd(amountAtomic: string | undefined): string | undefined {
  if (!amountAtomic) return undefined;
  try {
    const atomic = BigInt(amountAtomic);
    const whole = atomic / 1_000_000n;
    const fractional = (atomic % 1_000_000n).toString().padStart(6, "0");
    return `${whole}.${fractional}`.replace(/\.?0+$/, "");
  } catch {
    return undefined;
  }
}

async function assertPublicRealFileReport(
  seller: SellerHarness,
  selected: DefiGuardianSnapshotPositionV1,
): Promise<{ riskScore: number; recommendation: string }> {
  const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": "controlled-payment-public-check" },
    body: JSON.stringify(requestFor(selected)),
  });
  const body = (await response.json()) as {
    mode?: unknown;
    adapter?: { requestedMode?: unknown; resolvedMode?: unknown; fallbackUsed?: unknown; snapshotVersion?: unknown };
    position?: { tokenId?: unknown };
    risk?: { score?: unknown };
    recommendation?: { action?: unknown };
  };

  expect(response.status).toBe(200);
  expect(body.mode).toBe("adapter-real-file");
  expect(body.adapter?.requestedMode).toBe("adapter-real-file");
  expect(body.adapter?.resolvedMode).toBe("adapter-real-file");
  expect(body.adapter?.fallbackUsed).toBe(false);
  expect(body.adapter?.snapshotVersion).toBe("defi-guardian-snapshot-v1");
  expect(body.position?.tokenId).toBe(selected.tokenId);
  expect(typeof body.risk?.score).toBe("number");
  expect(typeof body.recommendation?.action).toBe("string");

  return {
    riskScore: body.risk?.score as number,
    recommendation: body.recommendation?.action as string,
  };
}

async function assertProtectedUnpaidRequirements(
  seller: SellerHarness,
  selected: DefiGuardianSnapshotPositionV1,
): Promise<{ network: string; asset: string; amountAtomic: string; amountUsd: string }> {
  const response = await fetch(`${seller.baseUrl}/paid/defi-risk-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": "controlled-payment-unpaid-check" },
    body: JSON.stringify(requestFor(selected)),
  });

  expect(response.status).toBe(402);
  const raw = response.headers.get("payment-required");
  expect(raw).toBeTruthy();
  const envelope = JSON.parse(Buffer.from(raw ?? "", "base64").toString("utf-8")) as { accepts?: AcceptEntry[] };
  const accept = envelope.accepts?.[0];
  expect(accept).toBeTruthy();
  if (!accept) throw new Error("missing payment requirements");

  const amountAtomic = accept.amount ?? accept.maxAmountRequired;
  const asset = accept.extra?.name ?? "";
  const amountUsd = atomicUsdcToUsd(amountAtomic);

  expect(MAINNET_NETWORKS.has(String(accept.network))).toBe(false);
  expect(accept.network).toBe(TESTNET_NETWORK);
  expect(asset).toBe(PAYMENT_ASSET);
  expect(amountAtomic).toBe(PAYMENT_AMOUNT_ATOMIC);
  expect(amountUsd).toBe(PAYMENT_AMOUNT_USD);
  expect(MAX_PAYMENT_ATTEMPTS).toBe(1);

  return {
    network: accept.network,
    asset,
    amountAtomic: amountAtomic ?? "",
    amountUsd: amountUsd ?? "",
  };
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function spawnNpm(args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", npmCommand(), ...args], {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }
  return spawn(npmCommand(), args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runBuyerPaymentPathOnce(
  seller: SellerHarness,
  selected: DefiGuardianSnapshotPositionV1,
): Promise<void> {
  const root = projectRoot();
  const result = await new Promise<{ code: number; output: string }>((resolveRun, rejectRun) => {
    const child = spawnNpm(
      ["--prefix", join(root, "buyer-client"), "run", "dev", "--", "--pay"],
      root,
      {
        ...sanitizeEnv(),
        SELLER_BASE_URL: seller.baseUrl,
        X402_NETWORK: TESTNET_NETWORK,
        MAX_PAYMENT_USD: PAYMENT_AMOUNT_USD,
        AGENTIC_AUDIT_LOG_DIR: mkdtempSync(join(tmpdir(), "agentic-payments-lab-controlled-payment-")),
        BUYER_REPORT_PROTOCOL: selected.protocol,
        BUYER_REPORT_CHAIN: selected.chain,
        BUYER_REPORT_TOKEN_ID: selected.tokenId,
        BUYER_REPORT_PAIR: selected.pair,
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    child.on("error", (error) => rejectRun(error));
    child.on("close", (code) => resolveRun({ code: code ?? 1, output }));
  });

  if (result.code !== 0) {
    throw new Error("buyer controlled payment path failed");
  }
  if (!result.output.includes("final response HTTP 200")) {
    throw new Error("buyer controlled payment path did not return HTTP 200");
  }
  if (!result.output.includes("adapter-real-file")) {
    throw new Error("buyer paid report did not use adapter-real-file");
  }
  if (!result.output.includes(selected.tokenId)) {
    throw new Error("buyer paid report did not include the selected tokenId");
  }
}

describeControlled("controlled Base Sepolia payment integration gate", () => {
  it("executes exactly one opt-in x402 payment and returns a paid real-local report", async () => {
    expect(enabled).toBe(true);
    expect(WRAPPER_PAYMENT_INVOCATIONS).toBe(1);
    expect(MAX_PAYMENT_ATTEMPTS).toBe(1);

    const buyerGuard = createPaidInvocationGuard();
    expect(buyerGuard.assertNext()).toBe(MAX_PAYMENT_ATTEMPTS);
    expect(() => buyerGuard.assertNext()).toThrow(
      "refusing more than one controlled payment invocation",
    );

    const { generatedAt, positions, selected } = loadSnapshotAndSelectActivePosition();
    let seller: SellerHarness | null = null;
    let paymentAttempts = 0;

    try {
      seller = await startTestSeller({ adapterMode: "real-file", snapshotPath: snapshotPath() });
      const publicReport = await assertPublicRealFileReport(seller, selected);
      const payment = await assertProtectedUnpaidRequirements(seller, selected);

      paymentAttempts += WRAPPER_PAYMENT_INVOCATIONS;
      expect(paymentAttempts).toBe(MAX_PAYMENT_ATTEMPTS);
      await runBuyerPaymentPathOnce(seller, selected);

      console.log(
        JSON.stringify({
          result: "CONTROLLED_PAYMENT_TEST_SUCCEEDED",
          snapshotGeneratedAt: generatedAt,
          positions,
          selectedTokenId: selected.tokenId,
          adapter: "adapter-real-file",
          fallbackUsed: false,
          riskScore: publicReport.riskScore,
          recommendation: publicReport.recommendation,
          payment,
          paymentAttempts,
        }),
      );
    } finally {
      await seller?.stop();
    }
  }, 120_000);
});
