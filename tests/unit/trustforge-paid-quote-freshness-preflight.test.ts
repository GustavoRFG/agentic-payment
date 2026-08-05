import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  buildProbeCandidateForAuthorizedQuote,
  evaluateFresh402AgainstAuthorizedQuote,
  evaluateFreshProbeResponseAgainstAuthorizedQuote,
} from "../../tools/trustforge/paid-quote-freshness-preflight";
import type { TargetHandshakeOutcome } from "../../tools/trustforge/target-liveness";
import { ZAPPER_TX_EXPLAINER_POLICY } from "../../tools/trustforge/rich-tx-explainer-policy";
import { createThinSettlementRequestBinding } from "../../tools/trustforge/thin-settlement-request-binding";
import { parseAndBindSellerPaymentRequirements } from "../../tools/trustforge/x402-seller-requirements-binding";
import { sellerRequirementsFixture } from "./_trustforge-seller-requirements-fixture";

const repoRoot = join(__dirname, "..", "..");
const endpoint = ZAPPER_TX_EXPLAINER_POLICY.endpointUrl;
const authorizedRequestBinding = createThinSettlementRequestBinding({
  endpoint,
  method: "POST",
  input_status: "known",
  query: [],
  body: {},
});

const authorizedSellerRequirements = sellerRequirementsFixture({
  requestBindingSha256: authorizedRequestBinding.binding_sha256,
  network: "eip155:8453",
  asset: MAINNET_USDC_ADDRESS,
  payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
  amountAtomic: "1125",
  endpoint,
  observedAt: "2026-06-20T00:00:00.000Z",
});

const authorized = {
  endpoint,
  quote_amount_usdc: "0.001125",
  quote_atomic: "1125",
  authorized_max_usdc: "0.01",
  pay_to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
  request_binding: authorizedRequestBinding,
  seller_requirements: authorizedSellerRequirements,
  canonical_requirements_sha256:
    authorizedSellerRequirements.binding.canonical_requirements_sha256,
  canonical_envelope_sha256: authorizedSellerRequirements.binding.canonical_envelope_sha256,
};

function liveOutcome(overrides: Partial<TargetHandshakeOutcome> = {}): TargetHandshakeOutcome {
  return {
    candidateId: "zapper_tx_explainer",
    resourceUrl: endpoint,
    status: "live_402_ok",
    httpStatus: 402,
    selectedAccept: {
      scheme: "exact",
      network: "eip155:8453",
      asset: MAINNET_USDC_ADDRESS,
      amountAtomic: "1125",
      payTo: authorized.pay_to,
      maxTimeoutSeconds: 300,
    },
    sellerRequirements: authorizedSellerRequirements,
    challenge: {
      nonce: null,
      expiresAt: null,
    },
    quoteAtomic: "1125",
    quoteUsdc: "0.001125",
    rawResponse: { httpStatus: 402, headers: {}, body: {}, bodySha256: null },
    detail: null,
    walletUsed: false,
    paymentAttempted: false,
    paymentBearingHttpRequestCount: 0,
    ...overrides,
  };
}

describe("paid quote freshness pre-flight", () => {
  it("returns go when fresh 402 matches the authorized quote and payTo", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome(),
      authorized,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("returns no-go when quote drifts above the authorized max", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome({
        quoteAtomic: "20000",
        quoteUsdc: "0.02",
        selectedAccept: {
          scheme: "exact",
          network: "eip155:8453",
          asset: MAINNET_USDC_ADDRESS,
          amountAtomic: "20000",
          payTo: authorized.pay_to,
          maxTimeoutSeconds: 300,
        },
      }),
      { ...authorized, authorized_max_usdc: "0.01" },
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("quote drift"))).toBe(true);
  });

  it("does not treat legacy ancillary challenge expiry as x402 core validity", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome({ challenge: { nonce: "n", expiresAt: "2020-01-01T00:00:00.000Z" } }),
      authorized,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("blocks a stale pay-time requirements observation at the effective deadline", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome(),
      {
        ...authorized,
        human_authorization_expires_at: "2026-06-20T00:15:00.000Z",
      },
      new Date("2026-06-20T00:05:00.000Z"),
    );
    expect(result.go).toBe(false);
    expect(result.reasons.join(" ")).toContain("BLOCKED_PAYMENT_REQUIREMENTS_STALE");
    expect(result.effective_signing_deadline).toBe("2026-06-20T00:05:00.000Z");
  });

  it("blocks exact-hash drift even when normalized quote fields still match", () => {
    const changed = sellerRequirementsFixture({
      requestBindingSha256: authorizedRequestBinding.binding_sha256,
      network: "eip155:8453",
      asset: MAINNET_USDC_ADDRESS,
      payTo: authorized.pay_to,
      amountAtomic: "1125",
      endpoint,
      extra: { name: "USDC", changed: true },
    });
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome({ sellerRequirements: changed }),
      authorized,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(false);
    expect(result.reasons.join(" ")).toContain("BLOCKED_PAYMENT_REQUIREMENTS_HASH_MISMATCH");
  });

  it("returns no-go on payTo mismatch", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome({
        selectedAccept: {
          scheme: "exact",
          network: "eip155:8453",
          asset: MAINNET_USDC_ADDRESS,
          amountAtomic: "1125",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 300,
        },
      }),
      authorized,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("payTo mismatch"))).toBe(true);
  });

  it("returns no-go on wrong network", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome({
        selectedAccept: {
          scheme: "exact",
          network: "eip155:84532",
          asset: MAINNET_USDC_ADDRESS,
          amountAtomic: "1125",
          payTo: authorized.pay_to,
          maxTimeoutSeconds: 300,
        },
      }),
      authorized,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("wrong network"))).toBe(true);
  });

  it("returns no-go on live 402 endpoint mismatch", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome({ resourceUrl: "https://fresh.example/x402" }),
      { ...authorized, endpoint: "https://candidate.example/x402" },
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(false);
    expect(result.reasons).toContain(
      "endpoint mismatch fresh=https://fresh.example/x402 authorized=https://candidate.example/x402",
    );
  });

  it("builds a generic probe candidate for non-allowlisted discovered endpoints", () => {
    const genericEndpoint = "https://valid-provider.example/x402/tx-details";
    const genericBinding = createThinSettlementRequestBinding({
      endpoint: genericEndpoint,
      method: "GET",
      input_status: "known",
      query: { network: "ethereum" },
      body: null,
    });
    const genericSellerRequirements = sellerRequirementsFixture({
      requestBindingSha256: genericBinding.binding_sha256,
      network: "eip155:8453",
      asset: MAINNET_USDC_ADDRESS,
      payTo: authorized.pay_to,
      amountAtomic: "1125",
      endpoint: genericEndpoint,
    });
    const candidate = buildProbeCandidateForAuthorizedQuote({
      ...authorized,
      endpoint: genericEndpoint,
      method: "GET",
      request_binding: genericBinding,
      seller_requirements: genericSellerRequirements,
      canonical_requirements_sha256:
        genericSellerRequirements.binding.canonical_requirements_sha256,
      canonical_envelope_sha256: genericSellerRequirements.binding.canonical_envelope_sha256,
      network: "eip155:8453",
      asset: MAINNET_USDC_ADDRESS,
    });
    expect(candidate.resourceUrl).toBe(genericEndpoint);
    expect(candidate.method).toBe("GET");
    expect(candidate.accepts[0]).toMatchObject({
      network: "eip155:8453",
      asset: MAINNET_USDC_ADDRESS,
      amountAtomic: "1125",
      payTo: authorized.pay_to,
    });
  });

  it("classifies a recorded Zapper fixture as go through the probe classifier", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(repoRoot, "trustforge", "fixtures", "bazaar_target_liveness", "zapper_phase5_live_402.json"),
        "utf8",
      ),
    );
    const parsed = parseAndBindSellerPaymentRequirements({
      headers: fixture.headers,
      body: fixture.body,
      requestBindingSha256: authorizedRequestBinding.binding_sha256,
      expectedNetwork: "eip155:8453",
      expectedAsset: MAINNET_USDC_ADDRESS,
      requirementsObservedAt: "2026-06-15T03:13:50.000Z",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const zapperAuthorized = {
      ...authorized,
      seller_requirements: parsed.observation,
      canonical_requirements_sha256:
        parsed.observation.binding.canonical_requirements_sha256,
      canonical_envelope_sha256: parsed.observation.binding.canonical_envelope_sha256,
    };
    const candidate = buildProbeCandidateForAuthorizedQuote(zapperAuthorized);
    expect(candidate).not.toBeNull();
    const result = evaluateFreshProbeResponseAgainstAuthorizedQuote(
      candidate!,
      {
        httpStatus: fixture.httpStatus,
        headers: fixture.headers,
        body: fixture.body,
      },
      zapperAuthorized,
      { now: new Date("2026-06-15T03:13:50.000Z") },
    );
    expect(result.go).toBe(true);
  });
});
