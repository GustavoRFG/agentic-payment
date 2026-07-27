import { describe, expect, it, vi } from "vitest";

import {
  adaptDiscoveredTargetWithPaidMethodProbe,
  type DiscoveredTargetSelectionPrimary,
} from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  extractBoundQuote,
  REJECTED_INCOMPLETE_402_CHALLENGE,
  REJECTED_QUOTE_SOURCE_DISAGREEMENT,
} from "../../tools/trustforge/quote-stability-probe";
import type { ProviderBlocklist } from "../../tools/trustforge/provider-blocklist";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";

const EMPTY_BLOCKLIST: ProviderBlocklist = { entries: [] };
const PAY_TO = "0x2222222222222222222222222222222222222222";

function body(
  amount: string,
  opts: { nonce?: string | null; expiresAt?: string | null } = {},
): string {
  const out: Record<string, unknown> = {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: MAINNET_NETWORK,
        asset: MAINNET_USDC_ADDRESS,
        maxAmountRequired: amount,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
      },
    ],
  };
  if (opts.nonce !== null) out.nonce = opts.nonce ?? "probe-nonce";
  if (opts.expiresAt !== null) out.expiresAt = opts.expiresAt ?? "2099-01-01T00:00:00.000Z";
  return JSON.stringify(out);
}

function response(bodyText: string): Response {
  return new Response(bodyText, { status: 402, headers: { "content-type": "application/json" } });
}

function candidate(quoteAtomic: string, quoteUsdc: string): DiscoveredTargetSelectionPrimary {
  return {
    method: "POST",
    handshakeStatus: "live_402_ok",
    resourceUrl: "https://quote.example/api/upload",
    quoteUsdc,
    quoteAtomic,
    selectedPayTo: PAY_TO,
    network: MAINNET_NETWORK,
    asset: MAINNET_USDC_ADDRESS,
    scoringRationale: [],
  };
}

function fetchReturning(bodyText: string) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(containsX402PaymentHeader(init?.headers)).toBe(false);
    return response(bodyText);
  }) as unknown as typeof fetch;
}

async function adaptOne(primary: DiscoveredTargetSelectionPrimary, fetchImpl: typeof fetch) {
  return adaptDiscoveredTargetWithPaidMethodProbe(
    { selection: { primary, fallbacks: [] } },
    { thin: true, fetchImpl, providerBlocklist: EMPTY_BLOCKLIST, now: new Date("2026-07-27T00:00:00.000Z") },
  );
}

describe("extractBoundQuote", () => {
  it("binds atomic + nonce + expiresAt from the same 402 (top-level challenge)", () => {
    const parsed = JSON.parse(body("2000000"));
    expect(extractBoundQuote({ headers: {}, body: parsed })).toEqual({
      atomic: "2000000",
      nonce: "probe-nonce",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });

  it("reads nonce/expiresAt from the chosen accept's extra when not top-level", () => {
    const parsed = {
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          maxAmountRequired: "1125",
          payTo: PAY_TO,
          extra: { nonce: "n-extra", expiresAt: "2099-02-02T00:00:00.000Z" },
        },
      ],
    };
    expect(extractBoundQuote({ headers: {}, body: parsed })).toEqual({
      atomic: "1125",
      nonce: "n-extra",
      expiresAt: "2099-02-02T00:00:00.000Z",
    });
  });

  it("reports missing challenge fields as null", () => {
    const parsed = JSON.parse(body("1125", { nonce: null, expiresAt: null }));
    expect(extractBoundQuote({ headers: {}, body: parsed })).toEqual({
      atomic: "1125",
      nonce: null,
      expiresAt: null,
    });
  });
});

describe("adapt quote binding — REJECTED_QUOTE_SOURCE_DISAGREEMENT", () => {
  it("rejects when the live 402 amount disagrees with the catalog quote (the 400x drift case)", async () => {
    // catalog says 5000 (stale census), the live+stable 402 says 2000000.
    const fetchImpl = fetchReturning(body("2000000"));
    const result = await adaptOne(candidate("5000", "0.005"), fetchImpl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(REJECTED_QUOTE_SOURCE_DISAGREEMENT);
    expect(result.reason).toContain("live_402=2000000");
    expect(result.reason).toContain("catalog=5000");
    const rejection = result.rejectedCandidates.find((r) =>
      r.reason.includes(REJECTED_QUOTE_SOURCE_DISAGREEMENT),
    );
    expect(rejection?.evidence?.quote_source).toEqual({ bound_atomic: "2000000", catalog_atomic: "5000" });
  });
});

describe("adapt quote binding — REJECTED_INCOMPLETE_402_CHALLENGE", () => {
  it("rejects a 402 with no nonce", async () => {
    const result = await adaptOne(candidate("1125", "0.001125"), fetchReturning(body("1125", { nonce: null })));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(REJECTED_INCOMPLETE_402_CHALLENGE);
    const rejection = result.rejectedCandidates.find((r) =>
      r.reason.includes(REJECTED_INCOMPLETE_402_CHALLENGE),
    );
    expect(rejection?.evidence?.challenge).toEqual({ nonce_present: false, expires_at_present: true });
  });

  it("rejects a 402 with no expiresAt", async () => {
    const result = await adaptOne(
      candidate("1125", "0.001125"),
      fetchReturning(body("1125", { expiresAt: null })),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(REJECTED_INCOMPLETE_402_CHALLENGE);
    const rejection = result.rejectedCandidates.find((r) =>
      r.reason.includes(REJECTED_INCOMPLETE_402_CHALLENGE),
    );
    expect(rejection?.evidence?.challenge).toEqual({ nonce_present: true, expires_at_present: false });
  });
});

describe("adapt quote binding — regression: stable, complete, agreeing quote materializes", () => {
  it("materializes with quote_atomic bound to the live 402 (identical to catalog) + binding evidence", async () => {
    const result = await adaptOne(candidate("1125", "0.001125"), fetchReturning(body("1125")));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.endpoint).toBe("https://quote.example/api/upload");
    // Bound to the live 402; identical to the (agreeing) catalog value.
    expect(result.candidate.quote_atomic).toBe("1125");
    expect(result.candidate.adapt_evidence?.quote_stability).toEqual({
      first_max_amount_required_atomic: "1125",
      second_max_amount_required_atomic: "1125",
    });
    expect(result.candidate.adapt_evidence?.quote_binding).toEqual({
      bound_atomic: "1125",
      catalog_atomic: "1125",
      nonce: "probe-nonce",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
  });
});
