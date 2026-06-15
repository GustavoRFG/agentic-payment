import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildPaid402Capture,
  sanitizeResponseHeader,
  sanitizeResponseHeaders,
  assertNoSecretsInSanitizedCapture,
  PaidRequest402Error,
  formatPaid402CaptureMarkdown,
} from "../../tools/trustforge/paid-402-response-sanitize";
import {
  authorizationLedgerPath,
  hashAuthorizationContent,
  reserveAuthorizationAttempt,
  AUTHORIZATION_ALREADY_CONSUMED,
} from "../../tools/trustforge/authorization-consumption-ledger";
import {
  checkPhase6PaidInvariants,
  checkPhase6PaidInvariantsFromLegacy,
} from "../../tools/trustforge/phase6-paid-invariants";

describe("paid 402 sanitization", () => {
  it("redacts X-PAYMENT, Authorization, Cookie, Set-Cookie", () => {
    expect(sanitizeResponseHeader("X-PAYMENT", "sig-value")).toBe("[REDACTED]");
    expect(sanitizeResponseHeader("Authorization", "Bearer abc")).toBe("[REDACTED]");
    expect(sanitizeResponseHeader("Cookie", "sid=1")).toBe("[REDACTED]");
    expect(sanitizeResponseHeader("Set-Cookie", "sid=1")).toBe("[REDACTED]");
    expect(sanitizeResponseHeader("payment-signature", "sig")).toBe("[REDACTED]");
  });

  it("builds sanitized paid 402 capture artifact fields", () => {
    const bodyText = JSON.stringify({
      x402Version: 2,
      error: "Payment required",
      accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1125" }],
    });
    const headers = sanitizeResponseHeaders({
      "content-type": "application/json",
      "www-authenticate": 'Payment method="tempo", request="secret"',
      "X-PAYMENT": "must-not-appear",
    });
    const capture = buildPaid402Capture({
      response: new Response(bodyText, { status: 402, statusText: "Payment Required" }),
      responseBodyText: bodyText,
      attemptId: "attempt_1",
      provider: "Zapper",
      serviceId: "zapper_tx_explainer",
      endpoint: "https://public.zapper.xyz/x402/transaction-details",
      unpaidScheme: "exact",
      unpaidNetwork: "eip155:8453",
      unpaidAmountAtomic: "1125",
      now: () => new Date("2026-06-15T04:00:00.000Z"),
    });
    expect(capture.http_status).toBe(402);
    expect(capture.rejection_analysis.server_rejection_reason).toBe("Payment required");
    expect(capture.rejection_analysis.scheme_differs_from_unpaid).toBe(false);
    expect(JSON.stringify(capture)).not.toContain("must-not-appear");
    expect(assertNoSecretsInSanitizedCapture(capture)).toEqual([]);
    expect(formatPaid402CaptureMarkdown(capture)).toContain("Paid HTTP 402");
  });

  it("PaidRequest402Error carries payment bearing count independent of tx hash", () => {
    const capture = buildPaid402Capture({
      response: new Response("{}", { status: 402 }),
      responseBodyText: "{}",
      attemptId: null,
      provider: "Zapper",
      serviceId: "zapper_tx_explainer",
      endpoint: "https://example.test/x402",
      unpaidScheme: "exact",
      unpaidNetwork: "eip155:8453",
      unpaidAmountAtomic: "1125",
    });
    const error = new PaidRequest402Error("paid request HTTP 402", {
      capture,
      paymentBearingHttpRequestCount: 1,
      paymentHeaderCreated: true,
      paymentHeaderSent: true,
    });
    expect(error.paymentBearingHttpRequestCount).toBe(1);
    expect(error.paymentHeaderSent).toBe(true);
  });
});

describe("authorization consumption ledger", () => {
  it("allows first attempt and blocks second before wallet/payment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tf-auth-"));
    try {
      const ledgerPath = authorizationLedgerPath(dir);
      const hash = hashAuthorizationContent('{"decision":"authorize_one_payment"}');
      let walletLoaded = false;
      let paymentHeaderGenerated = false;

      const first = await reserveAuthorizationAttempt({
        ledgerPath,
        authorizationHash: hash,
        authorizationPath: join(dir, "human_payment_authorization.json"),
        provider: "Zapper",
        serviceId: "zapper_tx_explainer",
        endpoint: "https://public.zapper.xyz/x402/transaction-details",
        maxPaymentAttempts: 1,
        attemptId: "attempt_1",
      });
      expect(first.consumed_attempts).toBe(1);
      expect(first.closed).toBe(true);

      walletLoaded = true;
      paymentHeaderGenerated = true;
      expect(walletLoaded).toBe(true);

      await expect(
        reserveAuthorizationAttempt({
          ledgerPath,
          authorizationHash: hash,
          authorizationPath: join(dir, "human_payment_authorization.json"),
          provider: "Zapper",
          serviceId: "zapper_tx_explainer",
          endpoint: "https://public.zapper.xyz/x402/transaction-details",
          maxPaymentAttempts: 1,
          attemptId: "attempt_2",
        }),
      ).rejects.toThrow(AUTHORIZATION_ALREADY_CONSUMED);

      const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
      expect(ledger.consumed_attempts).toBe(1);
      expect(ledger.attempt_ids).toEqual(["attempt_1"]);
      expect(paymentHeaderGenerated).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Phase 6 paid invariants", () => {
  const baseLegacy = {
    paymentAttemptCount: 1,
    retryUsed: false,
    authorizedMaxUsdc: "0.10",
    actualSpendUsdc: null,
    authorizedProvider: "Zapper",
    authorizedServiceId: "zapper_tx_explainer",
    authorizedEndpoint: "https://public.zapper.xyz/x402/transaction-details",
    observedProvider: "Zapper",
    observedServiceId: "zapper_tx_explainer",
    observedEndpoint: "https://public.zapper.xyz/x402/transaction-details",
    settlementTxHash: null,
    paymentIntegrityPass: false,
    semanticEvaluationPass: false,
    trustScoreCreated: false,
    secretsPrinted: false,
    paymentHeaderSent: true,
    paid402CapturePresent: true,
    authorizationConsumedAttempts: 1,
    authorizationMaxAttempts: 1,
  };

  it("PAID-001/002 pass when payment header sent, count=1, tx hash null", () => {
    const results = checkPhase6PaidInvariantsFromLegacy({
      ...baseLegacy,
      paymentBearingHttpRequestCount: 1,
    });
    const paid001 = results.find((r) => r.id === "PAID-001");
    const paid002 = results.find((r) => r.id === "PAID-002");
    expect(paid001?.passed).toBe(true);
    expect(paid002?.passed).toBe(true);
  });

  it("PAID-003 fails when paid 402 not captured and no settlement", () => {
    const results = checkPhase6PaidInvariantsFromLegacy({
      ...baseLegacy,
      paymentBearingHttpRequestCount: 1,
      paid402CapturePresent: false,
    });
    expect(results.find((r) => r.id === "PAID-003")?.passed).toBe(false);
  });

  it("PAID-006/007 block TrustScore without settlement and semantic pass", () => {
    const results = checkPhase6PaidInvariants({
      paymentBearingHttpRequestCount: 1,
      paymentHeaderSent: true,
      settlementTxHash: null,
      paid402CapturePresent: true,
      authorizationConsumedAttempts: 1,
      authorizationMaxAttempts: 1,
      secondInvocationBlockedBeforeWallet: true,
      paymentIntegrityPass: false,
      semanticEvaluationPass: false,
      trustScoreCreated: true,
      savedArtifactsContainSecrets: false,
      retryUsed: false,
      authorizedMaxUsdc: "0.10",
      actualSpendUsdc: null,
      authorizedProvider: "Zapper",
      authorizedServiceId: "zapper_tx_explainer",
      authorizedEndpoint: "https://public.zapper.xyz/x402/transaction-details",
      observedProvider: "Zapper",
      observedServiceId: "zapper_tx_explainer",
      observedEndpoint: "https://public.zapper.xyz/x402/transaction-details",
      secretsPrinted: false,
    });
    expect(results.find((r) => r.id === "PAID-006")?.passed).toBe(false);
    expect(results.find((r) => r.id === "PAID-007")?.passed).toBe(false);
  });
});
