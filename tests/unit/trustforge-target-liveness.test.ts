import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import type { BazaarResource } from "../../tools/trustforge/bazaar-client";
import { runTargetResolution } from "../../tools/trustforge/target-resolution";
import {
  classifyTargetProbeResponse,
  probeTargetLiveness,
  type RecordedProbeResponse,
} from "../../tools/trustforge/target-liveness";
import type { TargetCandidate } from "../../tools/trustforge/target-candidates";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";

const repoRoot = join(__dirname, "..", "..");

function headerNames(headers?: HeadersInit): string[] {
  if (!headers) return [];
  if (headers instanceof Headers) {
    const names: string[] = [];
    headers.forEach((_value, name) => names.push(name.toLowerCase()));
    return names;
  }
  if (Array.isArray(headers)) {
    return headers.map(([name]) => name.toLowerCase());
  }
  return Object.keys(headers).map((name) => name.toLowerCase());
}

function assertNoPaymentBearingHeaders(headers?: HeadersInit): void {
  expect(containsX402PaymentHeader(headers)).toBe(false);
  const names = headerNames(headers);
  expect(names).not.toContain("authorization");
  expect(names).not.toContain("x-payment");
  expect(names).not.toContain("payment-signature");
}

function assertUnsignedDiscoveryBody(body: BodyInit | null | undefined): void {
  if (body == null || body === "") return;
  const text = typeof body === "string" ? body : String(body);
  expect(text.toLowerCase()).not.toContain("payment-signature");
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(parsed).not.toHaveProperty("payment");
  expect(parsed).not.toHaveProperty("signature");
}

function readFixture(name: string): RecordedProbeResponse {
  const raw = JSON.parse(
    readFileSync(
      join(repoRoot, "trustforge", "fixtures", "bazaar_target_liveness", name),
      "utf8",
    ),
  ) as RecordedProbeResponse;
  return {
    httpStatus: raw.httpStatus,
    headers: raw.headers,
    body: raw.body,
  };
}

function candidate(): TargetCandidate {
  const body = {
    hash: "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060",
    chainId: 1,
  };
  return {
    candidateId: "zapper_tx_explainer",
    resourceUrl: "https://public.zapper.xyz/x402/transaction-details",
    method: "POST",
    x402Version: 2,
    freshness: {
      lastUpdated: "2026-06-15T03:13:41.125Z",
      sortKey: "2026-06-15T03:13:41.125Z",
    },
    registrationMetadata: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body,
          },
        },
      },
    },
    requestBinding: createThinSettlementRequestBinding({
      endpoint: "https://public.zapper.xyz/x402/transaction-details",
      method: "POST",
      input_status: "known",
      query: [],
      body,
    }),
    requestInputProvenance: "bazaar.extensions.bazaar.info.input",
    requestBindingError: null,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: MAINNET_USDC_ADDRESS,
        amountAtomic: "1125",
        payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
        maxTimeoutSeconds: 10,
      },
    ],
  };
}

function zapperResource(): BazaarResource {
  const probeCandidate = candidate();
  return {
    resourceUrl: probeCandidate.resourceUrl,
    type: "http",
    x402Version: probeCandidate.x402Version,
    lastUpdated: probeCandidate.freshness.lastUpdated,
    extensions: probeCandidate.registrationMetadata,
    accepts: probeCandidate.accepts.map((accept) => ({
      scheme: accept.scheme,
      network: accept.network,
      asset: accept.asset,
      amount: accept.amountAtomic,
      payTo: accept.payTo,
      maxTimeoutSeconds: accept.maxTimeoutSeconds,
      extra: { name: "USDC" },
    })),
  };
}

describe("Target liveness handshake probe", () => {
  it("classifies a real recorded Zapper 402 as live_402_ok", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      readFixture("zapper_phase5_live_402.json"),
      { maxTargetPriceAtomic: "10000" },
    );

    expect(outcome.status).toBe("live_402_ok");
    expect(outcome.quoteAtomic).toBe("1125");
    expect(outcome.quoteUsdc).toBe("0.001125");
    expect(outcome.challenge.nonce).toBe("7cbc2c3e-fbcb-4e15-a559-7136ed44b3d2");
    expect(outcome.challenge.expiresAt).toBe("2026-06-15T03:14:15.241Z");
    expect(outcome.walletUsed).toBe(false);
    expect(outcome.paymentAttempted).toBe(false);
  });

  it("classifies the same real 402 as over_budget when the budget is lower", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      readFixture("zapper_phase5_live_402.json"),
      { maxTargetPriceAtomic: "1000" },
    );

    expect(outcome.status).toBe("over_budget");
    expect(outcome.detail).toBe("HTTP 402 quote 1125 exceeds budget 1000");
  });

  it("classifies a real body-only 402 capture without accepts[] as malformed", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      readFixture("mvp_t0_body_only_malformed_402.json"),
      { maxTargetPriceAtomic: "10000" },
    );

    expect(outcome.status).toBe("malformed");
    expect(outcome.detail).toContain("REJECTED_PAYMENT_REQUIREMENTS_INCOMPLETE");
  });

  it("classifies non-402 responses as no_402", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      {
        httpStatus: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      },
      { maxTargetPriceAtomic: "10000" },
    );

    expect(outcome.status).toBe("no_402");
  });

  it("does not send a payment-bearing header during the probe", async () => {
    const fixture = readFixture("zapper_phase5_live_402.json");
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      assertNoPaymentBearingHeaders(init?.headers);
      assertUnsignedDiscoveryBody(init?.body ?? null);
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.httpStatus ?? 402,
        headers: fixture.headers,
      });
    }) as unknown as typeof fetch;

    const outcome = await probeTargetLiveness(candidate(), {
      fetchImpl,
      maxTargetPriceAtomic: "10000",
    });

    expect(capturedInit).toBeDefined();
    assertNoPaymentBearingHeaders(capturedInit?.headers);
    assertUnsignedDiscoveryBody(capturedInit?.body ?? null);
    expect(outcome.status).toBe("live_402_ok");
    expect(outcome.paymentBearingHttpRequestCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("probes OneSource network-info as GET with network=ethereum and no body", async () => {
    const fixture = readFixture("zapper_phase5_live_402.json");
    const endpoint = "https://api.onesource.io/api/chain/network-info";
    const base = candidate();
    const requestBinding = createThinSettlementRequestBinding({
      endpoint,
      method: "GET",
      input_status: "known",
      query: { network: "ethereum" },
      body: null,
    });
    const getCandidate: TargetCandidate = {
      ...base,
      candidateId: "onesource_network_info",
      resourceUrl: endpoint,
      method: "GET",
      requestBinding,
      requestInputProvenance: "bazaar.extensions.bazaar.info.input",
      requestBindingError: null,
    };
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe(endpoint);
      expect(url.searchParams.get("network")).toBe("ethereum");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      assertNoPaymentBearingHeaders(init?.headers);
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.httpStatus ?? 402,
        headers: fixture.headers,
      });
    }) as unknown as typeof fetch;

    const outcome = await probeTargetLiveness(getCandidate, {
      fetchImpl,
      maxTargetPriceAtomic: "10000",
    });
    expect(outcome.status).toBe("live_402_ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("makes zero payment-bearing HTTP requests across full target resolution", async () => {
    const fixture = readFixture("zapper_phase5_live_402.json");
    const captured: Array<{ headers?: HeadersInit; body?: BodyInit | null }> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      captured.push({ headers: init?.headers, body: init?.body ?? null });
      assertNoPaymentBearingHeaders(init?.headers);
      assertUnsignedDiscoveryBody(init?.body ?? null);
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.httpStatus ?? 402,
        headers: fixture.headers,
      });
    }) as unknown as typeof fetch;

    const report = await runTargetResolution({
      bazaarResources: [zapperResource()],
      fetchImpl,
      maxTargetPriceAtomic: "10000",
      env: {},
    });

    expect(captured.length).toBeGreaterThan(0);
    for (const request of captured) {
      assertNoPaymentBearingHeaders(request.headers);
      assertUnsignedDiscoveryBody(request.body);
    }
    expect(report.safety.paymentBearingHttpRequestCount).toBe(0);
    expect(report.safety.walletLoaded).toBe(false);
    expect(report.safety.settlementAttempted).toBe(false);
    expect(report.handshakeOutcomes[0]?.status).toBe("live_402_ok");
  });
});
