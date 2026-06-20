import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { TargetCandidate } from "../../tools/trustforge/target-candidates";
import { enrichTargetReliability } from "../../tools/trustforge/target-reliability-enrichment";

function candidate(url: string): TargetCandidate {
  return {
    candidateId: url,
    resourceUrl: url,
    method: "GET",
    x402Version: 2,
    freshness: { lastUpdated: null, sortKey: "" },
    registrationMetadata: {},
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: MAINNET_USDC_ADDRESS,
        amountAtomic: "1000",
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 300,
      },
    ],
  };
}

describe("optional target reliability enrichment", () => {
  it("is disabled by default and returns no metrics", async () => {
    const result = await enrichTargetReliability([candidate("https://a.example/x402")]);

    expect(result.enabled).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.metrics).toEqual([]);
    expect(result.logLines).toEqual(["reliability enrichment disabled"]);
  });

  it("loads live metrics from a configured indexer without gating selection", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          resources: [
            {
              resource_url: "https://a.example/x402",
              total_calls: 10,
              unique_payers: 2,
              success_signals: 3,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const result = await enrichTargetReliability(
      [candidate("https://a.example/x402")],
      {
        enabled: true,
        indexerUrl: "https://indexer.example/metrics",
        fetchImpl,
      },
    );

    expect(result.skipped).toBe(false);
    expect(result.source).toBe("live_indexer");
    expect(result.metrics).toEqual([
      {
        resourceUrl: "https://a.example/x402",
        reliabilityScore: 23,
        totalCalls: 10,
        uniquePayers: 2,
        successSignals: 3,
      },
    ]);
  });

  it("uses cached metrics and logs skip when the live indexer fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "trustforge-reliability-"));
    const cachePath = join(root, "cache", "metrics.json");
    mkdirSync(join(root, "cache"), { recursive: true });
    try {
      const fetchImpl = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
      await enrichTargetReliability([candidate("https://a.example/x402")], {
        enabled: true,
        indexerUrl: "https://indexer.example/metrics",
        fetchImpl: vi.fn(async () =>
          new Response(
            JSON.stringify({
              metrics: [
                {
                  resourceUrl: "https://a.example/x402",
                  reliabilityScore: 9,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ) as unknown as typeof fetch,
        cachePath,
      });

      const result = await enrichTargetReliability(
        [candidate("https://a.example/x402")],
        {
          enabled: true,
          indexerUrl: "https://indexer.example/metrics",
          fetchImpl,
          cachePath,
        },
      );

      expect(result.skipped).toBe(true);
      expect(result.cacheHit).toBe(true);
      expect(result.source).toBe("cache");
      expect(result.metrics[0]?.reliabilityScore).toBe(9);
      expect(result.logLines[0]).toContain("live fetch skipped");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
