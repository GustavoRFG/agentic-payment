import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseTargetsDiscoverArgs,
  runTrustForgeTargetsDiscover,
} from "../../tools/run-trustforge-targets-discover";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { BazaarResource } from "../../tools/trustforge/bazaar-client";
import type { TargetCandidate } from "../../tools/trustforge/target-candidates";
import type { TargetHandshakeOutcome } from "../../tools/trustforge/target-liveness";

function resource(input: {
  readonly url: string;
  readonly amount: string;
  readonly lastUpdated: string;
}): BazaarResource {
  return {
    resourceUrl: input.url,
    type: "http",
    x402Version: 2,
    lastUpdated: input.lastUpdated,
    extensions: {
      bazaar: {
        info: { input: { type: "http", method: "GET", queryParams: {} } },
      },
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: MAINNET_USDC_ADDRESS,
        amount: input.amount,
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 300,
        extra: {},
      },
    ],
  };
}

function liveOutcome(candidate: TargetCandidate, quoteAtomic: string): TargetHandshakeOutcome {
  return {
    candidateId: candidate.candidateId,
    resourceUrl: candidate.resourceUrl,
    status: "live_402_ok",
    httpStatus: 402,
    selectedAccept: {
      scheme: "exact",
      network: "eip155:8453",
      asset: MAINNET_USDC_ADDRESS,
      amountAtomic: quoteAtomic,
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 300,
    },
    challenge: {
      nonce: "nonce",
      expiresAt: "2026-06-20T00:00:00.000Z",
    },
    quoteAtomic,
    quoteUsdc: quoteAtomic === "1000" ? "0.001" : "0.002",
    rawResponse: { httpStatus: 402, headers: {}, body: {}, bodySha256: null },
    detail: null,
    walletUsed: false,
    paymentAttempted: false,
    paymentBearingHttpRequestCount: 0,
  };
}

describe("trustforge:targets:discover CLI", () => {
  it("parses discovery CLI flags", () => {
    const parsed = parseTargetsDiscoverArgs([
      "--run-dir",
      "D:\\trustforge\\artifacts\\runs\\bazaar-target-discovery\\run_test",
      "--output",
      "target_selection.json",
      "--max-target-price-atomic",
      "1000",
      "--facilitator-url",
      "https://x402.org/facilitator",
      "--with-indexer",
      "--indexer-url",
      "https://indexer.example/metrics",
      "--reliability-cache",
      "cache.json",
    ]);

    expect(parsed).toMatchObject({
      maxTargetPriceAtomic: "1000",
      facilitatorUrl: "https://x402.org/facilitator",
      withIndexer: true,
      indexerUrl: "https://indexer.example/metrics",
      reliabilityCachePath: "cache.json",
    });
  });

  it("writes target_selection.json and RESULT.txt without payment metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "tf-targets-cli-"));
    try {
      const runDir = join(root, "run");
      const outputPath = join(runDir, "target_selection.json");
      const result = await runTrustForgeTargetsDiscover({
        argv: [],
        runDir,
        outputPath,
        env: {},
        maxTargetPriceAtomic: "10000",
        bazaarResources: [
          resource({
            url: "https://primary.example/x402",
            amount: "1000",
            lastUpdated: "2026-06-20T00:00:00.000Z",
          }),
          resource({
            url: "https://fallback.example/x402",
            amount: "2000",
            lastUpdated: "2026-06-19T00:00:00.000Z",
          }),
        ],
        probeTarget: async (candidate) =>
          liveOutcome(candidate, candidate.resourceUrl.includes("fallback") ? "2000" : "1000"),
      });

      const report = JSON.parse(await readFile(outputPath, "utf8"));
      const resultText = await readFile(join(runDir, "RESULT.txt"), "utf8");

      expect(result.status).toBe("TARGET_RESOLUTION_READY");
      expect(report.chosenTarget.resourceUrl).toBe("https://primary.example/x402");
      expect(report.orderedFallbacks.map((entry: { resourceUrl: string }) => entry.resourceUrl)).toEqual([
        "https://fallback.example/x402",
      ]);
      expect(resultText).toContain("strict_no_payment: yes");
      expect(resultText).toContain("wallet_loaded: no");
      expect(resultText).toContain("payment_header_sent: no");
      expect(resultText).toContain("payment_attempted_live: no");
      expect(resultText).toContain("payment_bearing_http_request_count: 0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks when payment env flags are armed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tf-targets-cli-"));
    try {
      await expect(
        runTrustForgeTargetsDiscover({
          argv: [],
          runDir: join(root, "run"),
          bazaarResources: [],
          env: { BUYER_PRIVATE_KEY: "0x" + "a".repeat(64) },
        }),
      ).rejects.toThrow("BLOCKED_TARGET_RESOLUTION_PAYMENT_ENV: BUYER_PRIVATE_KEY");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
