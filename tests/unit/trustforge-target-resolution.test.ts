import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { BazaarResource } from "../../tools/trustforge/bazaar-client";
import {
  canonicalTargetResolution,
  runTargetResolution,
  stableStringifyCanonicalTargetResolution,
  targetResolutionEvidencePath,
} from "../../tools/trustforge/target-resolution";
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
        extra: { name: "USDC" },
      },
    ],
  };
}

function liveOutcome(
  candidate: TargetCandidate,
  quoteAtomic: string,
  challenge: { nonce: string; expiresAt: string } = {
    nonce: "nonce",
    expiresAt: "2026-06-20T00:00:00.000Z",
  },
): TargetHandshakeOutcome {
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
    challenge,
    quoteAtomic,
    quoteUsdc: quoteAtomic === "1000" ? "0.001" : "0.002",
    rawResponse: {
      httpStatus: 402,
      headers: { "www-authenticate": `Payment id="${challenge.nonce}"` },
      body: {},
      bodySha256: challenge.nonce,
    },
    detail: null,
    walletUsed: false,
    paymentAttempted: false,
    paymentBearingHttpRequestCount: 0,
  };
}

describe("TARGET RESOLUTION dry-run stage", () => {
  it("writes byte-stable target_selection.json with chosen target and fallbacks", async () => {
    const root = mkdtempSync(join(tmpdir(), "trustforge-target-resolution-"));
    mkdirSync(root, { recursive: true });
    try {
      const outputPath = join(root, "target_selection.json");
      const resources = [
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
        resource({
          url: "https://over-budget.example/x402",
          amount: "10001",
          lastUpdated: "2026-06-20T00:00:00.000Z",
        }),
      ];

      const report = await runTargetResolution({
        bazaarResources: resources,
        outputPath,
        maxTargetPriceAtomic: "10000",
        env: {},
        probeTarget: async (candidate) =>
          liveOutcome(candidate, candidate.resourceUrl.includes("fallback") ? "2000" : "1000"),
      });

      expect(report.chosenTarget?.resourceUrl).toBe("https://primary.example/x402");
      expect(report.orderedFallbacks.map((entry) => entry.resourceUrl)).toEqual([
        "https://fallback.example/x402",
      ]);
      expect(report.filter.rejected[0]?.reason).toBe("over_budget");
      expect(report.safety).toMatchObject({
        strictNoPayment: true,
        walletLoaded: false,
        paymentHeaderSent: false,
        settlementAttempted: false,
        paymentBearingHttpRequestCount: 0,
      });
      expect(readFileSync(outputPath, "utf8")).toBe(
        stableStringifyCanonicalTargetResolution(canonicalTargetResolution(report)),
      );
      expect(readFileSync(targetResolutionEvidencePath(outputPath), "utf8")).toContain(
        '"handshakeOutcomes"',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps target_selection.json byte-stable when only challenge nonce and expiry differ", async () => {
    const resources = [
      resource({
        url: "https://stable.example/x402",
        amount: "1000",
        lastUpdated: "2026-06-20T00:00:00.000Z",
      }),
    ];
    const root = mkdtempSync(join(tmpdir(), "trustforge-target-resolution-stable-"));
    const dirA = join(root, "a");
    const dirB = join(root, "b");
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    const outputA = join(dirA, "target_selection.json");
    const outputB = join(dirB, "target_selection.json");
    const baseOptions = {
      bazaarResources: resources,
      maxTargetPriceAtomic: "10000",
      env: {},
    };

    try {
      await runTargetResolution({
        ...baseOptions,
        outputPath: outputA,
        probeTarget: async (candidate) =>
          liveOutcome(candidate, "1000", {
            nonce: "nonce-a",
            expiresAt: "2026-06-20T00:00:00.000Z",
          }),
      });
      await runTargetResolution({
        ...baseOptions,
        outputPath: outputB,
        probeTarget: async (candidate) =>
          liveOutcome(candidate, "1000", {
            nonce: "nonce-b",
            expiresAt: "2026-06-21T00:00:00.000Z",
          }),
      });

      expect(readFileSync(outputA, "utf8")).toBe(readFileSync(outputB, "utf8"));
      expect(readFileSync(targetResolutionEvidencePath(outputA), "utf8")).not.toBe(
        readFileSync(targetResolutionEvidencePath(outputB), "utf8"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes byte-identically for identical injected discovery and probes", async () => {
    const resources = [
      resource({
        url: "https://stable.example/x402",
        amount: "1000",
        lastUpdated: "2026-06-20T00:00:00.000Z",
      }),
    ];
    const options = {
      bazaarResources: resources,
      maxTargetPriceAtomic: "10000",
      env: {},
      probeTarget: async (candidate: TargetCandidate) => liveOutcome(candidate, "1000"),
    };

    const first = await runTargetResolution(options);
    const second = await runTargetResolution(options);

    expect(JSON.stringify(first, null, 2)).toBe(JSON.stringify(second, null, 2));
  });

  it("blocks before discovery when payment env flags are armed", async () => {
    await expect(
      runTargetResolution({
        bazaarResources: [],
        env: { BUYER_PRIVATE_KEY: "0x" + "a".repeat(64) },
      }),
    ).rejects.toThrow("BLOCKED_TARGET_RESOLUTION_PAYMENT_ENV: BUYER_PRIVATE_KEY");
  });
});
