import { describe, expect, it, vi } from "vitest";

import {
  adaptDiscoveredTargetWithPaidMethodProbe,
  type DiscoveredTargetSelectionPrimary,
} from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  extractBoundQuote,
  REJECTED_INCOMPLETE_402_CHALLENGE,
  REJECTED_NON_POSITIVE_QUOTE,
  REJECTED_QUOTE_EXTRACTION_FAILED,
  REJECTED_QUOTE_SOURCE_DISAGREEMENT,
} from "../../tools/trustforge/quote-stability-probe";
import type { ProviderBlocklist } from "../../tools/trustforge/provider-blocklist";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";

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

function bodyUsingAmountField(
  amount: string,
  opts: { nonce?: string | null; expiresAt?: string | null } = {},
): string {
  const parsed = JSON.parse(body(amount, opts)) as {
    accepts: Array<Record<string, unknown>>;
  };
  const accept = parsed.accepts[0]!;
  delete accept.maxAmountRequired;
  accept.amount = amount;
  return JSON.stringify(parsed);
}

function response(bodyText: string): Response {
  return new Response(bodyText, { status: 402, headers: { "content-type": "application/json" } });
}

function candidate(quoteAtomic: string, quoteUsdc: string): DiscoveredTargetSelectionPrimary {
  const endpoint = "https://quote.example/api/upload";
  const binding = createThinSettlementRequestBinding({
    endpoint,
    method: "POST",
    input_status: "known",
    query: [],
    body: {},
  });
  return {
    method: "POST",
    handshakeStatus: "live_402_ok",
    resourceUrl: endpoint,
    requestEndpoint: binding.endpoint,
    requestInputStatus: "known",
    requestQuery: binding.query,
    requestBody: binding.body,
    requestInputProvenance: "bazaar.extensions.bazaar.info.input",
    requestBindingSha256: binding.binding_sha256,
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

function fetchReturningSequence(...bodyTexts: string[]) {
  let index = 0;
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(containsX402PaymentHeader(init?.headers)).toBe(false);
    const bodyText = bodyTexts[index++] ?? bodyTexts[bodyTexts.length - 1]!;
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
      rawSourceField: "maxAmountRequired",
      rawSourceValue: "2000000",
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
      rawSourceField: "maxAmountRequired",
      rawSourceValue: "1125",
    });
  });

  it("reports missing challenge fields as null", () => {
    const parsed = JSON.parse(body("1125", { nonce: null, expiresAt: null }));
    expect(extractBoundQuote({ headers: {}, body: parsed })).toEqual({
      atomic: "1125",
      nonce: null,
      expiresAt: null,
      rawSourceField: "maxAmountRequired",
      rawSourceValue: "1125",
    });
  });

  it("retains the invalid raw amount source when extraction fails", () => {
    const parsed = JSON.parse(body("-1"));
    expect(extractBoundQuote({ headers: {}, body: parsed })).toEqual({
      atomic: null,
      nonce: null,
      expiresAt: null,
      rawSourceField: "maxAmountRequired",
      rawSourceValue: "-1",
    });
  });
});

describe("adapt quote classification", () => {
  it("rejects an equal zero quote as non-positive without false instability or materialization", async () => {
    const fetchImpl = fetchReturning(bodyUsingAmountField("0"));
    const result = await adaptOne(candidate("0", "0"), fetchImpl);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(REJECTED_NON_POSITIVE_QUOTE);
    expect(result.reason).not.toContain("REJECTED_QUOTE_UNSTABLE");
    const rejection = result.rejectedCandidates.find((entry) =>
      entry.reason.includes(REJECTED_NON_POSITIVE_QUOTE),
    );
    expect(rejection?.evidence?.quote_stability).toEqual({
      first_max_amount_required_atomic: "0",
      second_max_amount_required_atomic: "0",
    });
    expect(rejection?.evidence?.quote_validation).toEqual({
      first_atomic: "0",
      second_atomic: "0",
      bound_atomic: "0",
      raw_source_field: "amount",
      raw_source_value: "0",
      endpoint: "https://quote.example/api/upload",
      method: "POST",
      http_status: 402,
      reason: rejection?.reason,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects absent amounts as extraction failure, never as instability", async () => {
    const missingAmount = JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          payTo: PAY_TO,
        },
      ],
      nonce: "probe-nonce",
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    const result = await adaptOne(candidate("1125", "0.001125"), fetchReturning(missingAmount));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(REJECTED_QUOTE_EXTRACTION_FAILED);
    expect(result.reason).not.toContain("REJECTED_QUOTE_UNSTABLE");
    const rejection = result.rejectedCandidates.find((entry) =>
      entry.reason.includes(REJECTED_QUOTE_EXTRACTION_FAILED),
    );
    expect(rejection?.evidence?.quote_validation).toMatchObject({
      first_atomic: null,
      second_atomic: null,
      bound_atomic: null,
      raw_source_field: null,
      raw_source_value: null,
      endpoint: "https://quote.example/api/upload",
      method: "POST",
      http_status: 402,
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
    const fetchImpl = fetchReturningSequence(
      body("1125", { nonce: "first-probe-nonce" }),
      body("1125", { nonce: "second-bound-nonce" }),
    );
    const result = await adaptOne(candidate("1125", "0.001125"), fetchImpl);

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
      nonce: "second-bound-nonce",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    expect(result.quoteStability?.bound).toMatchObject({
      atomic: "1125",
      nonce: "second-bound-nonce",
      rawSourceField: "maxAmountRequired",
      rawSourceValue: "1125",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
