import { describe, expect, it, vi } from "vitest";

import {
  adaptDiscoveredTargetWithPaidMethodProbe,
} from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  SKIPPED_BLOCKLISTED,
  blocklistEntryFor,
  isDomainBlocklisted,
  isDomainWatched,
  loadProviderBlocklist,
  partitionByBlocklist,
  watchEntryFor,
  type ProviderBlocklist,
} from "../../tools/trustforge/provider-blocklist";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";

function paymentRequiredBody(amount: string, payTo = "0x2222222222222222222222222222222222222222"): string {
  return JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: MAINNET_NETWORK,
        asset: MAINNET_USDC_ADDRESS,
        maxAmountRequired: amount,
        payTo,
        maxTimeoutSeconds: 300,
      },
    ],
  });
}

describe("provider blocklist config", () => {
  it("ships api.onesource.io as an evidence-backed entry", () => {
    const blocklist = loadProviderBlocklist();
    const entry = blocklist.entries.find((candidate) => candidate.domain === "api.onesource.io");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("PAID_REQUEST_405_AFTER_KEYLESS_402_OK");
    expect(entry?.evidence_runs).toEqual(["run_20260723_153238", "run_20260724_005838"]);
    expect(typeof entry?.added_at).toBe("string");
  });

  it("documents that removal is a human decision", () => {
    const blocklist = loadProviderBlocklist();
    expect(blocklist.note?.toLowerCase()).toContain("human");
  });

  it("ships stableenrich.dev as an evidence-backed entry (two runs, distinct days)", () => {
    const blocklist = loadProviderBlocklist();
    const entry = blocklist.entries.find((c) => c.domain === "stableenrich.dev");
    expect(entry).toBeDefined();
    expect(entry?.reason).toBe("PAY_TIME_402_EVAPORATION_AFTER_CONSISTENT_KEYLESS_402");
    expect(entry?.evidence_runs).toEqual(["run_20260724_044303", "run_20260726_130507"]);
  });
});

describe("evidence-strict policy: siblings are watched, not blocked", () => {
  const blocklist = loadProviderBlocklist();

  it("blocks stableenrich.dev (its own evidence) — excluded from discovery/adapt", () => {
    expect(isDomainBlocklisted("https://stableenrich.dev/x402", blocklist)).toBe(true);
    expect(isDomainWatched("https://stableenrich.dev/x402", blocklist)).toBe(false);
  });

  it("watches but does NOT block the same-operator siblings without their own run", () => {
    for (const sibling of ["https://stableupload.dev/x402", "https://stablestudio.dev/x402"]) {
      // Never excluded: absent from the blocklist predicates entirely.
      expect(isDomainBlocklisted(sibling, blocklist)).toBe(false);
      expect(blocklistEntryFor(sibling, blocklist)).toBeNull();
      // Present on the watch list, correlated to the blocked peer.
      expect(isDomainWatched(sibling, blocklist)).toBe(true);
      const watch = watchEntryFor(sibling, blocklist);
      expect(watch?.related_to).toBe("stableenrich.dev");
      expect(watch?.reason).toBe("WATCH_SAME_OPERATOR_AS_BLOCKED_PEER");
    }
  });

  it("keeps a watched-domain candidate in the allowed set (reaches selection)", () => {
    const items = [
      { resourceUrl: "https://stableupload.dev/x402" },
      { resourceUrl: "https://stableenrich.dev/x402" },
      { resourceUrl: "https://clean.example/x402" },
    ];
    const { allowed, skipped } = partitionByBlocklist(items, blocklist, (i) => i.resourceUrl);
    expect(allowed.map((i) => i.resourceUrl)).toEqual([
      "https://stableupload.dev/x402", // watched but NOT excluded
      "https://clean.example/x402",
    ]);
    expect(skipped.map((s) => s.item.resourceUrl)).toEqual(["https://stableenrich.dev/x402"]);
  });

  it("documents the watch policy (not a blocklist)", () => {
    expect(blocklist.watch_note?.toLowerCase()).toContain("not a blocklist");
    expect(blocklist.watch_note?.toLowerCase()).toContain("human");
  });
});

describe("provider blocklist matching", () => {
  const blocklist: ProviderBlocklist = {
    entries: [
      { domain: "api.onesource.io", reason: "R", evidence_runs: [], added_at: "2026-07-24T00:00:00Z" },
    ],
  };

  it("matches exact host and subdomains, path-insensitively", () => {
    expect(isDomainBlocklisted("https://api.onesource.io/x402", blocklist)).toBe(true);
    expect(isDomainBlocklisted("https://API.OneSource.io/anything?q=1", blocklist)).toBe(true);
    expect(isDomainBlocklisted("https://deep.api.onesource.io/x402", blocklist)).toBe(true);
  });

  it("does not match unrelated or sibling domains", () => {
    expect(isDomainBlocklisted("https://onesource.io.evil.example/x402", blocklist)).toBe(false);
    expect(isDomainBlocklisted("https://clean.example/x402", blocklist)).toBe(false);
    expect(blocklistEntryFor("not a url", blocklist)).toBeNull();
  });

  it("partitions candidates preserving order", () => {
    const items = [
      { resourceUrl: "https://clean.example/a" },
      { resourceUrl: "https://api.onesource.io/b" },
      { resourceUrl: "https://also-clean.example/c" },
    ];
    const { allowed, skipped } = partitionByBlocklist(items, blocklist, (i) => i.resourceUrl);
    expect(allowed.map((i) => i.resourceUrl)).toEqual([
      "https://clean.example/a",
      "https://also-clean.example/c",
    ]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.item.resourceUrl).toBe("https://api.onesource.io/b");
    expect(skipped[0]?.entry.domain).toBe("api.onesource.io");
  });
});

describe("adapt excludes blocklisted domains before ranking", () => {
  const blocklistedEndpoint = "https://api.onesource.io/x402";
  const cleanEndpoint = "https://clean.example/x402";

  function selection(primaryUrl: string, fallbackUrls: string[]) {
    return {
      selection: {
        primary: {
          method: "POST" as const,
          handshakeStatus: "live_402_ok",
          resourceUrl: primaryUrl,
          quoteUsdc: "0.001125",
          quoteAtomic: "1125",
          selectedPayTo: "0x2222222222222222222222222222222222222222",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          scoringRationale: ["primary"],
        },
        fallbacks: fallbackUrls.map((url) => ({
          method: "POST" as const,
          handshakeStatus: "live_402_ok",
          resourceUrl: url,
          quoteUsdc: "0.001125",
          quoteAtomic: "1125",
          selectedPayTo: "0x2222222222222222222222222222222222222222",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          scoringRationale: ["fallback"],
        })),
      },
    };
  }

  it("skips a blocklisted primary (via the shipped config), never probes it, and selects the clean fallback", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      // A blocklisted domain must never be contacted at all.
      expect(url.startsWith("https://api.onesource.io")).toBe(false);
      if (url === cleanEndpoint) {
        return new Response(paymentRequiredBody("1125"), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await adaptDiscoveredTargetWithPaidMethodProbe(
      selection(blocklistedEndpoint, [cleanEndpoint]),
      { thin: true, fetchImpl, now: new Date("2026-07-24T00:00:00.000Z") },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.endpoint).toBe(cleanEndpoint);
    const onesourceRejection = result.rejectedCandidates.find(
      (r) => r.resourceUrl === blocklistedEndpoint,
    );
    expect(onesourceRejection?.reason).toBe(
      `${SKIPPED_BLOCKLISTED}: api.onesource.io (PAID_REQUEST_405_AFTER_KEYLESS_402_OK)`,
    );
    expect(onesourceRejection?.evidence?.blocklist).toMatchObject({
      domain: "api.onesource.io",
      reason: "PAID_REQUEST_405_AFTER_KEYLESS_402_OK",
      evidence_runs: ["run_20260723_153238", "run_20260724_005838"],
    });
    // A.3: the reinterpretation note ships with the entry.
    expect(onesourceRejection?.evidence?.blocklist?.reinterpretation).toContain("POST-to-GET");
    const contactedOnesource = fetchImpl.mock.calls.some(([url]) =>
      String(url).startsWith("https://api.onesource.io"),
    );
    expect(contactedOnesource).toBe(false);
  });

  it("never reaches a selected candidate when every candidate is blocklisted", async () => {
    const fetchImpl = vi.fn(async () => new Response("unexpected", { status: 500 })) as unknown as typeof fetch;

    const result = await adaptDiscoveredTargetWithPaidMethodProbe(
      selection("https://api.onesource.io/a", ["https://sub.api.onesource.io/b"]),
      {
        thin: true,
        fetchImpl,
        now: new Date("2026-07-24T00:00:00.000Z"),
        providerBlocklist: {
          entries: [
            { domain: "api.onesource.io", reason: "PAID_REQUEST_405_AFTER_KEYLESS_402_OK", evidence_runs: [], added_at: "2026-07-24T00:00:00Z" },
          ],
        },
      },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Honest per-cause reason (the last real exclusion), not a generic phrase.
    expect(result.reason).toContain(SKIPPED_BLOCKLISTED);
    expect(result.rejectedCandidates).toHaveLength(2);
    expect(result.rejectedCandidates.every((r) => r.reason.startsWith(SKIPPED_BLOCKLISTED))).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
