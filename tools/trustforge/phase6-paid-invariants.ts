/**
 * phase6-paid-invariants — PAID-001 through PAID-008 (Phase 6 / 6.1).
 */

export interface Phase6PaidContext {
  readonly paymentBearingHttpRequestCount: number;
  readonly paymentHeaderSent: boolean;
  readonly settlementTxHash: string | null;
  readonly paid402CapturePresent: boolean;
  readonly authorizationConsumedAttempts: number;
  readonly authorizationMaxAttempts: number;
  readonly secondInvocationBlockedBeforeWallet: boolean | null;
  readonly paymentIntegrityPass: boolean;
  readonly semanticEvaluationPass: boolean;
  readonly trustScoreCreated: boolean;
  readonly savedArtifactsContainSecrets: boolean;
  readonly retryUsed: boolean;
  readonly authorizedMaxUsdc: string;
  readonly actualSpendUsdc: string | null;
  readonly authorizedProvider: string;
  readonly authorizedServiceId: string;
  readonly authorizedEndpoint: string;
  readonly observedProvider: string;
  readonly observedServiceId: string;
  readonly observedEndpoint: string;
  readonly secretsPrinted: boolean;
}

export interface Phase6PaidInvariantResult {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
}

export function checkPhase6PaidInvariants(
  ctx: Phase6PaidContext,
): readonly Phase6PaidInvariantResult[] {
  const results: Phase6PaidInvariantResult[] = [];

  results.push({
    id: "PAID-001",
    passed:
      !ctx.paymentHeaderSent || ctx.paymentBearingHttpRequestCount >= 1,
    detail:
      "payment_bearing_http_request_count reflects payment-header requests, not settlement success",
  });

  results.push({
    id: "PAID-002",
    passed:
      ctx.settlementTxHash == null && ctx.paymentHeaderSent
        ? ctx.paymentBearingHttpRequestCount > 0
        : true,
    detail: "payment_bearing_http_request_count does not depend on transaction_hash",
  });

  results.push({
    id: "PAID-003",
    passed:
      !ctx.paymentHeaderSent ||
      ctx.paid402CapturePresent ||
      ctx.settlementTxHash != null,
    detail:
      "failed paid 402 after payment header is captured as sanitized artifact (or settlement succeeded)",
  });

  results.push({
    id: "PAID-004",
    passed: ctx.authorizationConsumedAttempts <= ctx.authorizationMaxAttempts,
    detail: "authorization cannot be consumed more than max_payment_attempts",
  });

  results.push({
    id: "PAID-005",
    passed:
      ctx.secondInvocationBlockedBeforeWallet == null ||
      ctx.secondInvocationBlockedBeforeWallet === true,
    detail: "second invocation with consumed authorization is blocked before wallet load",
  });

  results.push({
    id: "PAID-006",
    passed:
      !ctx.trustScoreCreated ||
      (ctx.paymentIntegrityPass && Boolean(ctx.settlementTxHash)),
    detail: "no TrustScore if settlement evidence missing/fail",
  });

  results.push({
    id: "PAID-007",
    passed: !ctx.trustScoreCreated || ctx.semanticEvaluationPass,
    detail: "no TrustScore if semantic evaluation missing/fail",
  });

  results.push({
    id: "PAID-008",
    passed: !ctx.savedArtifactsContainSecrets && !ctx.secretsPrinted,
    detail: "no secret-bearing headers in saved artifacts",
  });

  return results;
}

export function allPhase6PaidInvariantsPassed(
  results: readonly Phase6PaidInvariantResult[],
): boolean {
  return results.every((r) => r.passed);
}

/** Legacy Phase 6 post-run context (kept for finalize compatibility). */
export interface Phase6PaidLegacyContext {
  readonly paymentBearingHttpRequestCount: number;
  readonly paymentAttemptCount: number;
  readonly retryUsed: boolean;
  readonly authorizedMaxUsdc: string;
  readonly actualSpendUsdc: string | null;
  readonly authorizedProvider: string;
  readonly authorizedServiceId: string;
  readonly authorizedEndpoint: string;
  readonly observedProvider: string;
  readonly observedServiceId: string;
  readonly observedEndpoint: string;
  readonly settlementTxHash: string | null;
  readonly paymentIntegrityPass: boolean;
  readonly semanticEvaluationPass: boolean;
  readonly trustScoreCreated: boolean;
  readonly secretsPrinted: boolean;
  readonly paymentHeaderSent?: boolean;
  readonly paid402CapturePresent?: boolean;
  readonly authorizationConsumedAttempts?: number;
  readonly authorizationMaxAttempts?: number;
}

export function checkPhase6PaidInvariantsFromLegacy(
  ctx: Phase6PaidLegacyContext,
): readonly Phase6PaidInvariantResult[] {
  return checkPhase6PaidInvariants({
    paymentBearingHttpRequestCount: ctx.paymentBearingHttpRequestCount,
    paymentHeaderSent: ctx.paymentHeaderSent ?? ctx.paymentAttemptCount > 0,
    settlementTxHash: ctx.settlementTxHash,
    paid402CapturePresent: ctx.paid402CapturePresent ?? false,
    authorizationConsumedAttempts: ctx.authorizationConsumedAttempts ?? ctx.paymentAttemptCount,
    authorizationMaxAttempts: ctx.authorizationMaxAttempts ?? 1,
    secondInvocationBlockedBeforeWallet: null,
    paymentIntegrityPass: ctx.paymentIntegrityPass,
    semanticEvaluationPass: ctx.semanticEvaluationPass,
    trustScoreCreated: ctx.trustScoreCreated,
    savedArtifactsContainSecrets: false,
    retryUsed: ctx.retryUsed,
    authorizedMaxUsdc: ctx.authorizedMaxUsdc,
    actualSpendUsdc: ctx.actualSpendUsdc,
    authorizedProvider: ctx.authorizedProvider,
    authorizedServiceId: ctx.authorizedServiceId,
    authorizedEndpoint: ctx.authorizedEndpoint,
    observedProvider: ctx.observedProvider,
    observedServiceId: ctx.observedServiceId,
    observedEndpoint: ctx.observedEndpoint,
    secretsPrinted: ctx.secretsPrinted,
  });
}
