import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import { MAX_PAYMENT_ATTEMPTS } from "../../shared/payment-safety";

describe("buyer paid invocation guard", () => {
  it("allows the first paid invocation", () => {
    const guard = createPaidInvocationGuard();

    expect(guard.assertNext()).toBe(1);
    expect(guard.getAttempts()).toBe(1);
  });

  it("refuses a second paid invocation", () => {
    const guard = createPaidInvocationGuard();

    guard.assertNext();

    expect(() => guard.assertNext()).toThrow(
      "refusing more than one controlled payment invocation",
    );
    expect(guard.getAttempts()).toBe(2);
  });

  it("keeps max attempts fixed at one", () => {
    expect(MAX_PAYMENT_ATTEMPTS).toBe(1);
  });

  it("keeps the dry-run code path outside the paid invocation guard", () => {
    const source = readFileSync(
      join(process.cwd(), "buyer-client", "src", "call-paid-report.ts"),
      "utf8",
    );
    const dryRunStart = source.indexOf("async function runDryRun()");
    const payStart = source.indexOf("async function runPay()");
    const dryRunBody =
      dryRunStart >= 0 && payStart > dryRunStart
        ? source.slice(dryRunStart, payStart)
        : "";
    const payBody = payStart >= 0 ? source.slice(payStart) : "";

    expect(dryRunBody).toBeTruthy();
    expect(dryRunBody).not.toContain("paidInvocationGuard.assertNext()");
    expect(payBody).toBeTruthy();
    expect(payBody).toContain("paidInvocationGuard.assertNext()");
    expect(payBody).toContain("fetchWithPayment");
  });
});
