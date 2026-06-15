/**
 * run-trustforge-phase6-invariants — offline PAID-001..008 checks (no payment).
 */

import { pathToFileURL } from "node:url";
import {
  checkPhase6PaidInvariants,
  allPhase6PaidInvariantsPassed,
} from "./trustforge/phase6-paid-invariants";
import {
  buildPaid402Capture,
  assertNoSecretsInSanitizedCapture,
  sanitizeResponseHeader,
} from "./trustforge/paid-402-response-sanitize";
import {
  hashAuthorizationContent,
  reserveAuthorizationAttempt,
  authorizationLedgerPath,
  AUTHORIZATION_ALREADY_CONSUMED,
} from "./trustforge/authorization-consumption-ledger";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function main(): Promise<number> {
  process.env.TRUSTFORGE_PHASE4_NO_PAYMENT = "YES_STRICTLY_NO_PAYMENT";
  process.env.TRUSTFORGE_DISABLE_PAID_EXECUTION = "YES";

  const synthetic = checkPhase6PaidInvariants({
    paymentBearingHttpRequestCount: 1,
    paymentHeaderSent: true,
    settlementTxHash: null,
    paid402CapturePresent: true,
    authorizationConsumedAttempts: 1,
    authorizationMaxAttempts: 1,
    secondInvocationBlockedBeforeWallet: true,
    paymentIntegrityPass: false,
    semanticEvaluationPass: false,
    trustScoreCreated: false,
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
  if (!allPhase6PaidInvariantsPassed(synthetic)) {
    console.error("synthetic PAID invariant fixture failed");
    return 1;
  }

  const headers = new Headers({
    "content-type": "application/json",
    "www-authenticate": 'Payment method="tempo", request="secret"',
    "payment-signature": "must-redact",
    Authorization: "Bearer secret-token",
    Cookie: "session=abc",
  });
  const bodyText = JSON.stringify({
    x402Version: 2,
    error: "Payment required",
    accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1125" }],
  });
  const response = new Response(bodyText, {
    status: 402,
    statusText: "Payment Required",
    headers,
  });
  const capture = buildPaid402Capture({
    response,
    responseBodyText: bodyText,
    attemptId: "test_attempt",
    provider: "Zapper",
    serviceId: "zapper_tx_explainer",
    endpoint: "https://public.zapper.xyz/x402/transaction-details",
    unpaidScheme: "exact",
    unpaidNetwork: "eip155:8453",
    unpaidAmountAtomic: "1125",
  });
  if (assertNoSecretsInSanitizedCapture(capture).length > 0) {
    console.error("sanitized capture leaked secrets");
    return 1;
  }
  if (sanitizeResponseHeader("X-PAYMENT", "raw") !== "[REDACTED]") {
    console.error("X-PAYMENT not redacted");
    return 1;
  }

  const tmp = await mkdtemp(join(tmpdir(), "tf-phase6-auth-"));
  try {
    const ledgerPath = authorizationLedgerPath(tmp);
    const hash = hashAuthorizationContent('{"decision":"authorize_one_payment"}');
    await reserveAuthorizationAttempt({
      ledgerPath,
      authorizationHash: hash,
      authorizationPath: join(tmp, "human_payment_authorization.json"),
      provider: "Zapper",
      serviceId: "zapper_tx_explainer",
      endpoint: "https://public.zapper.xyz/x402/transaction-details",
      maxPaymentAttempts: 1,
      attemptId: "attempt_1",
      now: () => new Date("2026-06-15T04:00:00.000Z"),
    });
    let blocked = false;
    try {
      await reserveAuthorizationAttempt({
        ledgerPath,
        authorizationHash: hash,
        authorizationPath: join(tmp, "human_payment_authorization.json"),
        provider: "Zapper",
        serviceId: "zapper_tx_explainer",
        endpoint: "https://public.zapper.xyz/x402/transaction-details",
        maxPaymentAttempts: 1,
        attemptId: "attempt_2",
      });
    } catch (error) {
      blocked =
        error instanceof Error && error.message === AUTHORIZATION_ALREADY_CONSUMED;
    }
    if (!blocked) {
      console.error("expected second authorization reservation to be blocked");
      return 1;
    }
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    if (ledger.consumed_attempts !== 1 || !ledger.closed) {
      console.error("ledger consumption state incorrect");
      return 1;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log("Phase 6 PAID invariants: PASS");
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { main as runPhase6InvariantsMain };
