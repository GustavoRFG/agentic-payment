import { describe, expect, it, vi } from "vitest";

import {
  PIN_EXCLUDED_HANDSHAKE_MALFORMED,
  PIN_EXCLUDED_NOT_IN_FRESH_DISCOVERY,
  adaptDiscoveredTargetWithPaidMethodProbe,
  resolvePinnedCandidate,
  type DiscoveredTargetSelectionPrimary,
} from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
  SETTLEMENT_PAID_HTTP_METHOD,
} from "../../tools/trustforge/paid-method-honored-probe";
import { SKIPPED_BLOCKLISTED, type ProviderBlocklist } from "../../tools/trustforge/provider-blocklist";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";

const EMPTY_BLOCKLIST: ProviderBlocklist = { entries: [] };

function candidate(
  overrides: Partial<DiscoveredTargetSelectionPrimary> & { resourceUrl: string },
): DiscoveredTargetSelectionPrimary {
  return {
    method: "POST",
    handshakeStatus: "live_402_ok",
    quoteUsdc: "0.001125",
    quoteAtomic: "1125",
    selectedPayTo: "0x2222222222222222222222222222222222222222",
    network: MAINNET_NETWORK,
    asset: MAINNET_USDC_ADDRESS,
    scoringRationale: [],
    ...overrides,
  };
}

function paymentRequiredBody(amount: string): string {
  return JSON.stringify({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: MAINNET_NETWORK,
        asset: MAINNET_USDC_ADDRESS,
        maxAmountRequired: amount,
        payTo: "0x2222222222222222222222222222222222222222",
        maxTimeoutSeconds: 300,
      },
    ],
    nonce: "probe-nonce",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

describe("resolvePinnedCandidate — honest causes against the fresh selection", () => {
  const fresh: DiscoveredTargetSelectionPrimary[] = [
    candidate({ resourceUrl: "https://post.example/x402" }),
    candidate({ resourceUrl: "https://get.example/x402", method: "GET" }),
    candidate({ resourceUrl: "https://malformed.example/x402", handshakeStatus: "malformed" }),
  ];

  it("EXCLUDED_NOT_IN_FRESH_DISCOVERY when the pin is not among the fresh candidates", () => {
    const res = resolvePinnedCandidate(fresh, "https://absent.example/x402", EMPTY_BLOCKLIST);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain(PIN_EXCLUDED_NOT_IN_FRESH_DISCOVERY);
  });

  it("REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER when the pin's catalog method != POST", () => {
    const res = resolvePinnedCandidate(fresh, "https://get.example/x402", EMPTY_BLOCKLIST);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain(REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER);
    expect(res.evidence?.method).toEqual({ catalog_method: "GET", thin_runner_method: SETTLEMENT_PAID_HTTP_METHOD });
  });

  it("EXCLUDED_HANDSHAKE_MALFORMED when the pin's handshake is not live_402_ok", () => {
    const res = resolvePinnedCandidate(fresh, "https://malformed.example/x402", EMPTY_BLOCKLIST);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain(PIN_EXCLUDED_HANDSHAKE_MALFORMED);
  });

  it("SKIPPED_BLOCKLISTED when the pin's domain is blocklisted", () => {
    const res = resolvePinnedCandidate(fresh, "https://post.example/x402", {
      entries: [{ domain: "post.example", reason: "R", evidence_runs: [], added_at: "2026-07-25T00:00:00Z" }],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain(SKIPPED_BLOCKLISTED);
  });

  it("ok for a well-formed POST pin present in the fresh selection", () => {
    const res = resolvePinnedCandidate(fresh, "https://post.example/x402", EMPTY_BLOCKLIST);
    expect(res.ok).toBe(true);
  });
});

describe("adapt — method-awareness (A.1)", () => {
  it("rejects a lone non-POST primary up front without any probe", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await adaptDiscoveredTargetWithPaidMethodProbe(
      { selection: { primary: candidate({ resourceUrl: "https://get.example/x402", method: "GET" }), fallbacks: [] } },
      { thin: true, fetchImpl, providerBlocklist: EMPTY_BLOCKLIST, now: new Date("2026-07-25T00:00:00.000Z") },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("adapt — pin honored strictly vs --pin-with-fallback (B)", () => {
  const pinUrl = "https://get.example/x402";
  const fallbackUrl = "https://post.example/x402";
  const selection = {
    selection: {
      primary: candidate({ resourceUrl: pinUrl, method: "GET" as const }),
      fallbacks: [candidate({ resourceUrl: fallbackUrl })],
    },
  };

  it("strict pin: an excluded pin is terminal with the honest cause; the fallback is never tried", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await adaptDiscoveredTargetWithPaidMethodProbe(selection, {
      thin: true,
      fetchImpl,
      providerBlocklist: EMPTY_BLOCKLIST,
      resourceUrl: pinUrl,
      now: new Date("2026-07-25T00:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER);
    expect(result.rejectedCandidates).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("--pin-with-fallback: an excluded pin drops to the ranking in the same execution", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      expect(url).toBe(fallbackUrl);
      return new Response(paymentRequiredBody("1125"), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await adaptDiscoveredTargetWithPaidMethodProbe(selection, {
      thin: true,
      fetchImpl,
      providerBlocklist: EMPTY_BLOCKLIST,
      resourceUrl: pinUrl,
      pinWithFallback: true,
      now: new Date("2026-07-25T00:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.endpoint).toBe(fallbackUrl);
    // pin recorded as excluded, fallback selected
    expect(result.rejectedCandidates.some((r) => r.reason.includes(REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER))).toBe(true);
  });

  it("valid pin without fallback selects only the pin", async () => {
    const validPin = "https://post.example/x402";
    const other = "https://other.example/x402";
    const sel = {
      selection: {
        primary: candidate({ resourceUrl: validPin }),
        fallbacks: [candidate({ resourceUrl: other })],
      },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(validPin);
      return new Response(paymentRequiredBody("1125"), {
        status: 402,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await adaptDiscoveredTargetWithPaidMethodProbe(sel, {
      thin: true,
      fetchImpl,
      providerBlocklist: EMPTY_BLOCKLIST,
      resourceUrl: validPin,
      now: new Date("2026-07-25T00:00:00.000Z"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.endpoint).toBe(validPin);
    const contactedOther = fetchImpl.mock.calls.some(([url]) => String(url) === other);
    expect(contactedOther).toBe(false);
  });
});
