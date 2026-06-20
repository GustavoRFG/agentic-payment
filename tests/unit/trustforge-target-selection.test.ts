import { describe, expect, it } from "vitest";

import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { TargetCandidate } from "../../tools/trustforge/target-candidates";
import type { TargetHandshakeOutcome } from "../../tools/trustforge/target-liveness";
import {
  selectTargets,
  stableStringifyTargetSelection,
} from "../../tools/trustforge/target-selection";

function candidate(input: {
  readonly id: string;
  readonly url: string;
  readonly freshness: string;
}): TargetCandidate {
  return {
    candidateId: input.id,
    resourceUrl: input.url,
    method: "GET",
    x402Version: 2,
    freshness: {
      lastUpdated: input.freshness,
      sortKey: input.freshness,
    },
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

function outcome(input: {
  readonly id: string;
  readonly url: string;
  readonly status?: TargetHandshakeOutcome["status"];
  readonly quoteAtomic?: string;
}): TargetHandshakeOutcome {
  const status = input.status ?? "live_402_ok";
  return {
    candidateId: input.id,
    resourceUrl: input.url,
    status,
    httpStatus: status === "no_402" ? 200 : 402,
    selectedAccept:
      status === "live_402_ok"
        ? {
            scheme: "exact",
            network: "eip155:8453",
            asset: MAINNET_USDC_ADDRESS,
            amountAtomic: input.quoteAtomic ?? "1000",
            payTo: "0x1111111111111111111111111111111111111111",
            maxTimeoutSeconds: 300,
          }
        : null,
    challenge: {
      nonce: status === "live_402_ok" ? "nonce" : null,
      expiresAt: status === "live_402_ok" ? "2026-06-20T00:00:00.000Z" : null,
    },
    quoteAtomic: status === "live_402_ok" ? input.quoteAtomic ?? "1000" : null,
    quoteUsdc: status === "live_402_ok" ? "0.001" : null,
    rawResponse: {
      httpStatus: status === "no_402" ? 200 : 402,
      headers: {},
      body: {},
      bodySha256: null,
    },
    detail: status === "live_402_ok" ? null : `fixture ${status}`,
    walletUsed: false,
    paymentAttempted: false,
    paymentBearingHttpRequestCount: 0,
  };
}

describe("deterministic target selection", () => {
  it("ranks live targets by price ascending, then freshness descending", () => {
    const cheapOld = candidate({
      id: "cheap_old",
      url: "https://cheap-old.example/x402",
      freshness: "2026-06-01T00:00:00.000Z",
    });
    const expensiveNew = candidate({
      id: "expensive_new",
      url: "https://expensive-new.example/x402",
      freshness: "2026-06-20T00:00:00.000Z",
    });
    const cheapNew = candidate({
      id: "cheap_new",
      url: "https://cheap-new.example/x402",
      freshness: "2026-06-20T00:00:00.000Z",
    });

    const report = selectTargets({
      candidates: [expensiveNew, cheapOld, cheapNew],
      outcomes: [
        outcome({ id: "expensive_new", url: expensiveNew.resourceUrl, quoteAtomic: "2000" }),
        outcome({ id: "cheap_old", url: cheapOld.resourceUrl, quoteAtomic: "1000" }),
        outcome({ id: "cheap_new", url: cheapNew.resourceUrl, quoteAtomic: "1000" }),
      ],
    });

    expect(report.primary?.candidateId).toBe("cheap_new");
    expect(report.fallbacks.map((entry) => entry.candidateId)).toEqual([
      "cheap_old",
      "expensive_new",
    ]);
  });

  it("excludes a flaky no_402 target and selects a live fallback", () => {
    const flaky = candidate({
      id: "known_bad_flaky",
      url: "https://flaky.example/x402",
      freshness: "2026-06-20T00:00:00.000Z",
    });
    const fallback = candidate({
      id: "live_fallback",
      url: "https://fallback.example/x402",
      freshness: "2026-06-19T00:00:00.000Z",
    });

    const report = selectTargets({
      candidates: [flaky, fallback],
      outcomes: [
        outcome({ id: "known_bad_flaky", url: flaky.resourceUrl, status: "no_402" }),
        outcome({ id: "live_fallback", url: fallback.resourceUrl, quoteAtomic: "1000" }),
      ],
    });

    expect(report.primary?.candidateId).toBe("live_fallback");
    expect(report.considered).toContainEqual({
      candidateId: "known_bad_flaky",
      resourceUrl: "https://flaky.example/x402",
      handshakeStatus: "no_402",
      selected: false,
      exclusionReason: "handshake_status=no_402",
    });
  });

  it("serializes byte-identically for identical inputs", () => {
    const first = selectTargets({
      candidates: [
        candidate({
          id: "a",
          url: "https://a.example/x402",
          freshness: "2026-06-20T00:00:00.000Z",
        }),
      ],
      outcomes: [
        outcome({
          id: "a",
          url: "https://a.example/x402",
          quoteAtomic: "1000",
        }),
      ],
    });
    const second = selectTargets({
      candidates: [
        candidate({
          id: "a",
          url: "https://a.example/x402",
          freshness: "2026-06-20T00:00:00.000Z",
        }),
      ],
      outcomes: [
        outcome({
          id: "a",
          url: "https://a.example/x402",
          quoteAtomic: "1000",
        }),
      ],
    });

    expect(stableStringifyTargetSelection(first)).toBe(
      stableStringifyTargetSelection(second),
    );
  });
});
