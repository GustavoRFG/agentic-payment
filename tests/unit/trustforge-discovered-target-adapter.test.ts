import { describe, expect, it, vi } from "vitest";

import {
  adaptDiscoveredPrimaryToSelectedCandidate,
  adaptDiscoveredPrimaryToThinSettlementCandidate,
  adaptDiscoveredTargetWithPaidMethodProbe,
  recommendedAuthorizationMaxUsdc,
} from "../../tools/trustforge/discovered-target-to-selected-candidate";
import {
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
  REJECTED_PAID_METHOD_NOT_HONORED,
  SETTLEMENT_PAID_HTTP_METHOD,
} from "../../tools/trustforge/paid-method-honored-probe";
import { REJECTED_QUOTE_UNSTABLE } from "../../tools/trustforge/quote-stability-probe";
import { ZAPPER_TX_EXPLAINER_POLICY } from "../../tools/trustforge/rich-tx-explainer-policy";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";

const endpoint = ZAPPER_TX_EXPLAINER_POLICY.endpointUrl;

function requestFields(
  resourceUrl: string,
  method: "GET" | "POST",
  query: unknown = [],
  body: unknown = {},
) {
  const binding = createThinSettlementRequestBinding({
    endpoint: resourceUrl,
    method,
    input_status: "known",
    query,
    body: method === "GET" ? null : body,
  });
  return {
    requestEndpoint: binding.endpoint,
    requestInputStatus: "known" as const,
    requestQuery: binding.query,
    requestBody: binding.body,
    requestInputProvenance: "bazaar.extensions.bazaar.info.input" as const,
    requestBindingSha256: binding.binding_sha256,
  };
}

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
    nonce: "probe-nonce",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
}

describe("discovered target adapter", () => {
  it("rejects an old target-selection artifact without a persisted request binding", () => {
    const result = adaptDiscoveredPrimaryToThinSettlementCandidate({
      selection: {
        primary: {
          method: "GET",
          handshakeStatus: "live_402_ok",
          resourceUrl: "https://api.onesource.io/api/chain/network-info",
          quoteUsdc: "0.001",
          quoteAtomic: "1000",
          selectedPayTo: "0x1111111111111111111111111111111111111111",
          scoringRationale: [],
        },
        fallbacks: [],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("REJECTED_REQUEST_BINDING_NOT_PERSISTED");
  });

  it("maps a live_402_ok primary to selected_candidate with audit metadata", () => {
    const result = adaptDiscoveredPrimaryToSelectedCandidate(
      {
        selection: {
          primary: {
            method: "POST",
            handshakeStatus: "live_402_ok",
            resourceUrl: endpoint,
            ...requestFields(endpoint, "POST"),
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
            scoringRationale: ["price_atomic=1125"],
          },
          fallbacks: [{ resourceUrl: "https://fallback.example/x402" }],
        },
      },
      new Date("2026-06-20T00:00:00.000Z"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate).toMatchObject({
      provider: "Zapper",
      service_id: "zapper_tx_explainer",
      endpoint,
      network: "eip155:8453",
      quote_amount_usdc: "0.001125",
      quote_atomic: "1125",
      authorized_pay_to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
      target_selection_audit: {
        selected_resource_url: endpoint,
        handshake_status: "live_402_ok",
        fallback_resource_urls: ["https://fallback.example/x402"],
        scoring_rationale: ["price_atomic=1125"],
      },
    });
  });

  it("rejects absent or non-live primaries without emitting a candidate", () => {
    expect(
      adaptDiscoveredPrimaryToSelectedCandidate({
        selection: { primary: null, fallbacks: [] },
      }).ok,
    ).toBe(false);
    expect(
      adaptDiscoveredPrimaryToSelectedCandidate({
        selection: {
          primary: {
            handshakeStatus: "malformed",
            resourceUrl: endpoint,
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
            scoringRationale: [],
          },
          fallbacks: [],
        },
      }).ok,
    ).toBe(false);
  });

  it("caps recommended max usdc at the centavo-scale ceiling", () => {
    expect(recommendedAuthorizationMaxUsdc("0.001125")).toBe("0.002125");
    expect(recommendedAuthorizationMaxUsdc("0.009")).toBe("0.01");
  });

  it("only pins Zapper when an explicit resource_url selector is passed", () => {
    const autonomousEndpoint = "https://autonomous.example/x402/tx-details";
    const selection = {
      selection: {
        primary: {
          method: "GET" as const,
          handshakeStatus: "live_402_ok",
          resourceUrl: autonomousEndpoint,
          ...requestFields(autonomousEndpoint, "GET"),
          quoteUsdc: "0.001",
          quoteAtomic: "1000",
          selectedPayTo: "0x1111111111111111111111111111111111111111",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          scoringRationale: ["price_atomic=1000"],
        },
        fallbacks: [
          {
            method: "POST" as const,
            handshakeStatus: "live_402_ok",
            resourceUrl: endpoint,
            ...requestFields(endpoint, "POST"),
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
            network: MAINNET_NETWORK,
            asset: MAINNET_USDC_ADDRESS,
            scoringRationale: ["price_atomic=1125"],
          },
        ],
      },
    };

    const autonomous = adaptDiscoveredPrimaryToThinSettlementCandidate(
      selection,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(autonomous.ok).toBe(true);
    if (!autonomous.ok) return;
    expect(autonomous.candidate.endpoint).toBe(autonomousEndpoint);
    expect(autonomous.candidate.provider).toBe("discovered_x402");

    const pinned = adaptDiscoveredPrimaryToThinSettlementCandidate(
      selection,
      new Date("2026-06-20T00:00:00.000Z"),
      { resourceUrl: endpoint },
    );
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    expect(pinned.candidate).toMatchObject({
      provider: "Zapper",
      service_id: "zapper_tx_explainer",
      endpoint,
      method: "POST",
      target_selection_audit: {
        selected_resource_url: endpoint,
        fallback_resource_urls: [autonomousEndpoint],
      },
    });
  });

  it("rejects an unsupported PUT catalog-method candidate before probing and falls to the POST fallback", async () => {
    const unsupportedEndpoint = "https://put-only.example/x402/quote";
    const postOkEndpoint = "https://post-ok.example/x402/settle";
    const selection = {
      selection: {
        primary: {
          method: "PUT" as const,
          handshakeStatus: "live_402_ok",
          resourceUrl: unsupportedEndpoint,
          quoteUsdc: "0.001",
          quoteAtomic: "1000",
          selectedPayTo: "0x1111111111111111111111111111111111111111",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          scoringRationale: ["handshake_get_402"],
        },
        fallbacks: [
          {
            method: "POST" as const,
            handshakeStatus: "live_402_ok",
            resourceUrl: postOkEndpoint,
            ...requestFields(postOkEndpoint, "POST"),
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x2222222222222222222222222222222222222222",
            network: MAINNET_NETWORK,
            asset: MAINNET_USDC_ADDRESS,
            scoringRationale: ["handshake_post_402"],
          },
        ],
      },
    };

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      if (url === unsupportedEndpoint && method === "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (url === postOkEndpoint && method === "POST") {
        return new Response(paymentRequiredBody("1125"), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await adaptDiscoveredTargetWithPaidMethodProbe(selection, {
      thin: true,
      fetchImpl,
      now: new Date("2026-06-20T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.endpoint).toBe(postOkEndpoint);
    expect(result.paidMethodProbe?.method).toBe(SETTLEMENT_PAID_HTTP_METHOD);
    expect(result.paidMethodProbe?.httpStatus).toBe(402);
    expect(result.candidate.adapt_evidence?.quote_stability).toEqual({
      first_max_amount_required_atomic: "1125",
      second_max_amount_required_atomic: "1125",
    });
    // The PUT candidate is excluded up front by catalog method — never probed.
    expect(result.rejectedCandidates).toEqual([
      {
        resourceUrl: unsupportedEndpoint,
        reason: `${REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER}: catalog method PUT not in POST, GET`,
        evidence: {
          method: { catalog_method: "PUT", thin_runner_method: "POST|GET" },
        },
      },
    ]);
    const contactedUnsupported = fetchImpl.mock.calls.some(([url]) => String(url) === unsupportedEndpoint);
    expect(contactedUnsupported).toBe(false);
    const probedMethods = fetchImpl.mock.calls.map(
      ([, init]) => (init as RequestInit | undefined)?.method ?? "GET",
    );
    expect(probedMethods.every((method) => method === "POST")).toBe(true);
    // method probe + second 402 for the accepted fallback only
    expect(fetchImpl.mock.calls.filter(([url]) => String(url) === postOkEndpoint)).toHaveLength(2);
  });

  it("selects a GET-only candidate without accidentally probing it with POST", async () => {
    const getOnlyEndpoint = "https://get-only.example/x402/quote";
    const selection = {
      selection: {
        primary: {
          method: "GET" as const,
          handshakeStatus: "live_402_ok",
          resourceUrl: getOnlyEndpoint,
          ...requestFields(getOnlyEndpoint, "GET", { network: "ethereum" }),
          quoteUsdc: "0.001125",
          quoteAtomic: "1125",
          selectedPayTo: "0x2222222222222222222222222222222222222222",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          scoringRationale: ["handshake_get_402"],
        },
        fallbacks: [],
      },
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      expect(new Headers(init?.headers).has("payment-signature")).toBe(false);
      expect(new Headers(init?.headers).has("x-payment")).toBe(false);
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(getOnlyEndpoint);
      expect(url.searchParams.get("network")).toBe("ethereum");
      expect(init?.body).toBeUndefined();
      if (init?.method === "POST") {
        return new Response("Method Not Allowed", { status: 405 });
      }
      if (init?.method === "GET") {
        return new Response(paymentRequiredBody("1125"), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected method", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await adaptDiscoveredTargetWithPaidMethodProbe(selection, {
      thin: true,
      fetchImpl,
      now: new Date("2026-07-28T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.endpoint).toBe(getOnlyEndpoint);
    expect(result.candidate.method).toBe("GET");
    expect(result.candidate.request_query).toEqual([["network", "ethereum"]]);
    expect(result.candidate.request_body).toBeNull();
    expect(result.candidate.request_binding_sha256).toBe(
      selection.selection.primary.requestBindingSha256,
    );
    expect(result.paidMethodProbe?.method).toBe("GET");
    expect(result.paidMethodProbe?.httpStatus).toBe(402);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("detects a query change after target selection before any probe", async () => {
    const target = "https://api.onesource.io/api/chain/network-info";
    const persisted = requestFields(target, "GET", { network: "ethereum" });
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await adaptDiscoveredTargetWithPaidMethodProbe(
      {
        selection: {
          primary: {
            method: "GET",
            handshakeStatus: "live_402_ok",
            resourceUrl: target,
            ...persisted,
            requestQuery: [["network", "base"]],
            quoteUsdc: "0.001",
            quoteAtomic: "1000",
            selectedPayTo: "0x1111111111111111111111111111111111111111",
            scoringRationale: [],
          },
          fallbacks: [],
        },
      },
      { thin: true, fetchImpl, providerBlocklist: { entries: [] } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("REJECTED_REQUEST_BINDING_INVALID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects alternating maxAmountRequired quotes with REJECTED_QUOTE_UNSTABLE and falls back", async () => {
    const unstableEndpoint = "https://unstable-quote.example/x402";
    const stableEndpoint = "https://stable-quote.example/x402";
    const selection = {
      selection: {
        primary: {
          method: "POST" as const,
          handshakeStatus: "live_402_ok",
          resourceUrl: unstableEndpoint,
          ...requestFields(unstableEndpoint, "POST"),
          quoteUsdc: "0.001",
          quoteAtomic: "1000",
          selectedPayTo: "0x1111111111111111111111111111111111111111",
          network: MAINNET_NETWORK,
          asset: MAINNET_USDC_ADDRESS,
          scoringRationale: ["unstable_primary"],
        },
        fallbacks: [
          {
            method: "POST" as const,
            handshakeStatus: "live_402_ok",
            resourceUrl: stableEndpoint,
            ...requestFields(stableEndpoint, "POST"),
            quoteUsdc: "0.001125",
            quoteAtomic: "1125",
            selectedPayTo: "0x2222222222222222222222222222222222222222",
            network: MAINNET_NETWORK,
            asset: MAINNET_USDC_ADDRESS,
            scoringRationale: ["stable_fallback"],
          },
        ],
      },
    };

    const unstableQuotes = ["1000", "2500"];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect((init?.method ?? "GET").toUpperCase()).toBe("POST");
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      if (url === unstableEndpoint) {
        const amount = unstableQuotes.shift() ?? "9999";
        return new Response(paymentRequiredBody(amount, "0x1111111111111111111111111111111111111111"), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      if (url === stableEndpoint) {
        return new Response(paymentRequiredBody("1125"), {
          status: 402,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    const result = await adaptDiscoveredTargetWithPaidMethodProbe(selection, {
      thin: true,
      fetchImpl,
      now: new Date("2026-06-20T00:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.candidate.endpoint).toBe(stableEndpoint);
    expect(result.candidate.adapt_evidence?.quote_stability).toEqual({
      first_max_amount_required_atomic: "1125",
      second_max_amount_required_atomic: "1125",
    });
    expect(result.rejectedCandidates).toEqual([
      {
        resourceUrl: unstableEndpoint,
        reason: `${REJECTED_QUOTE_UNSTABLE}: first=1000 second=2500`,
        evidence: {
          quote_stability: {
            first_max_amount_required_atomic: "1000",
            second_max_amount_required_atomic: "2500",
          },
        },
      },
    ]);
  });
});
