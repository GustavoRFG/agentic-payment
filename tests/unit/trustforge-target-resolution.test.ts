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
import { sellerRequirementsFixture } from "./_trustforge-seller-requirements-fixture";

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
    sellerRequirements: candidate.requestBinding
      ? sellerRequirementsFixture({
          requestBindingSha256: candidate.requestBinding.binding_sha256,
          network: "eip155:8453",
          asset: MAINNET_USDC_ADDRESS,
          payTo: "0x1111111111111111111111111111111111111111",
          amountAtomic: quoteAtomic,
          endpoint: candidate.resourceUrl,
        })
      : null,
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
      expect(report.schema_version).toBe("trustforge_target_resolution.v4");
      expect(report.selection.schema_version).toBe("trustforge_target_selection.v4");
      expect(report.chosenTarget).toMatchObject({
        requestInputStatus: "known",
        requestQuery: [],
        requestBody: null,
        requestInputProvenance: "bazaar.extensions.bazaar.info.input",
      });
      expect(report.chosenTarget?.requestBindingSha256).toMatch(/^[0-9a-f]{64}$/);
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
      const evidence = JSON.parse(
        readFileSync(targetResolutionEvidencePath(outputPath), "utf8"),
      );
      expect(evidence.schema_version).toBe("trustforge_target_resolution_evidence.v4");
      expect(evidence.candidateRequestBindings[0]).toMatchObject({
        requestInputProvenance: "bazaar.extensions.bazaar.info.input",
      });
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

  it("persists OneSource network=ethereum request binding in selection and evidence", async () => {
    const endpoint = "https://api.onesource.io/api/chain/network-info";
    const base = resource({
      url: endpoint,
      amount: "1000",
      lastUpdated: "2026-08-02T00:59:27.948Z",
    });
    const onesource: BazaarResource = {
      ...base,
      extensions: {
        bazaar: {
          info: {
            input: {
              type: "http",
              method: "GET",
              queryParams: { network: "ethereum" },
              body: { network: "ethereum" },
            },
          },
        },
      },
    };
    const root = mkdtempSync(join(tmpdir(), "trustforge-onesource-binding-"));
    try {
      const outputPath = join(root, "target_selection.json");
      const report = await runTargetResolution({
        bazaarResources: [onesource],
        outputPath,
        maxTargetPriceAtomic: "10000",
        env: {},
        probeTarget: async (candidate) => liveOutcome(candidate, "1000"),
      });
      expect(report.selection.primary).toMatchObject({
        resourceUrl: endpoint,
        method: "GET",
        requestQuery: [["network", "ethereum"]],
        requestBody: null,
      });
      const evidence = JSON.parse(
        readFileSync(targetResolutionEvidencePath(outputPath), "utf8"),
      );
      expect(evidence.candidateRequestBindings[0].requestBinding.query).toEqual([
        ["network", "ethereum"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks before discovery when payment env flags are armed", async () => {
    await expect(
      runTargetResolution({
        bazaarResources: [],
        env: { BUYER_PRIVATE_KEY: "0x" + "a".repeat(64) },
      }),
    ).rejects.toThrow("BLOCKED_TARGET_RESOLUTION_PAYMENT_ENV: BUYER_PRIVATE_KEY");
  });

  it("never persists catalog credentials or authorization headers in request-binding artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "trustforge-target-sensitive-"));
    try {
      const outputPath = join(root, "target_selection.json");
      const sensitive = resource({
        url: "https://sensitive.example/x402",
        amount: "1000",
        lastUpdated: "2026-06-20T00:00:00.000Z",
      });
      const withSecret: BazaarResource = {
        ...sensitive,
        extensions: {
          bazaar: {
            info: {
              input: {
                type: "http",
                method: "POST",
                body: { password: "DO_NOT_PERSIST_ME" },
                headers: { authorization: "Bearer DO_NOT_PERSIST_ME" },
              },
            },
          },
        },
      };
      const report = await runTargetResolution({
        bazaarResources: [withSecret],
        outputPath,
        maxTargetPriceAtomic: "10000",
        env: {},
        probeTarget: async (candidate) => liveOutcome(candidate, "1000"),
      });
      expect(report.selection.primary).toBeNull();
      const artifacts =
        readFileSync(outputPath, "utf8") +
        readFileSync(targetResolutionEvidencePath(outputPath), "utf8");
      expect(artifacts).not.toContain("DO_NOT_PERSIST_ME");
      expect(artifacts.toLowerCase()).not.toContain("bearer ");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
