/**
 * phase6-paid-invariants — PAID-001 through PAID-008 post-paid checks.
 */

export interface Phase6PaidContext {
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
    passed: ctx.paymentBearingHttpRequestCount === 1,
    detail: "Exactly one payment-bearing HTTP request",
  });

  results.push({
    id: "PAID-002",
    passed: !ctx.retryUsed,
    detail: "No retry after payment-bearing request",
  });

  results.push({
    id: "PAID-003",
    passed: ctx.paymentAttemptCount === 1,
    detail: "Payment ledger has exactly one attempt",
  });

  results.push({
    id: "PAID-004",
    passed: Boolean(ctx.settlementTxHash),
    detail: "Settlement evidence linked to attempt (tx hash present or reconciled)",
  });

  results.push({
    id: "PAID-005",
    passed:
      !ctx.trustScoreCreated ||
      (ctx.paymentIntegrityPass && ctx.semanticEvaluationPass),
    detail: "TrustScore blocked unless payment integrity + semantic evaluation pass",
  });

  const spendOk =
    ctx.actualSpendUsdc != null &&
    compareUsdcStrings(ctx.actualSpendUsdc, ctx.authorizedMaxUsdc) <= 0;
  results.push({
    id: "PAID-006",
    passed: ctx.actualSpendUsdc == null ? false : spendOk,
    detail: "Payment amount <= authorized cap",
  });

  results.push({
    id: "PAID-007",
    passed:
      ctx.observedProvider === ctx.authorizedProvider &&
      ctx.observedServiceId === ctx.authorizedServiceId &&
      ctx.observedEndpoint === ctx.authorizedEndpoint,
    detail: "Provider and endpoint match authorization",
  });

  results.push({
    id: "PAID-008",
    passed: !ctx.secretsPrinted,
    detail: "No secrets printed",
  });

  return results;
}

function compareUsdcStrings(a: string, b: string): number {
  const normalize = (value: string) => {
    const [whole, frac = ""] = value.split(".");
    const micro =
      BigInt(whole || "0") * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
    return micro;
  };
  const av = normalize(a);
  const bv = normalize(b);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export function allPhase6PaidInvariantsPassed(
  results: readonly Phase6PaidInvariantResult[],
): boolean {
  return results.every((r) => r.passed);
}
