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

const repoRoot = join(__dirname, "..", "..");
const endpoint = ZAPPER_TX_EXPLAINER_POLICY.endpointUrl;

const authorized = {
  endpoint,
  quote_amount_usdc: "0.001125",
  quote_atomic: "1125",
  authorized_max_usdc: "0.01",
  pay_to: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
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
    challenge: {
      nonce: "fresh-nonce",
      expiresAt: "2099-01-01T00:00:00.000Z",
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

  it("returns no-go when the challenge is expired", () => {
    const result = evaluateFresh402AgainstAuthorizedQuote(
      liveOutcome({ challenge: { nonce: "n", expiresAt: "2020-01-01T00:00:00.000Z" } }),
      authorized,
      new Date("2026-06-20T00:00:00.000Z"),
    );
    expect(result.go).toBe(false);
    expect(result.reasons.some((reason) => reason.includes("expired"))).toBe(true);
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

  it("classifies a recorded Zapper fixture as go through the probe classifier", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(repoRoot, "trustforge", "fixtures", "bazaar_target_liveness", "zapper_phase5_live_402.json"),
        "utf8",
      ),
    );
    const candidate = buildProbeCandidateForAuthorizedQuote(authorized);
    expect(candidate).not.toBeNull();
    const result = evaluateFreshProbeResponseAgainstAuthorizedQuote(
      candidate!,
      {
        httpStatus: fixture.httpStatus,
        headers: fixture.headers,
        body: fixture.body,
      },
      authorized,
      { now: new Date("2026-06-15T03:13:50.000Z") },
    );
    expect(result.go).toBe(true);
  });
});
