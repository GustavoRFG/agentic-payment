import { describe, expect, it } from "vitest";

import type { BoundedReconcileResult } from "../../tools/trustforge/bounded-reconcile-spawn";
import {
  RECONCILIATION_RPC_TIMEOUT,
  RECONCILIATION_SUBPROCESS_FAILED,
  buildReconciliationSubprocessFailedLedger,
  buildReconciliationTimeoutLedger,
  isReconciliationUnavailableStatus,
  materializeReconcileLedger,
} from "../../tools/trustforge/reconciliation-availability";
import {
  classifyX402Settlement,
  parseReconciliationLedger,
} from "../../tools/trustforge/x402-settlement-classify";
import { startAbortDeadline } from "../../tools/trustforge/abort-deadline";

function result(overrides: Partial<BoundedReconcileResult>): BoundedReconcileResult {
  return { ok: false, timedOut: false, exitCode: null, signal: null, stderr: "", ...overrides };
}

/** Mirror of the classify-runner unavailability gate. */
function reconciliationUnavailable(parsed: ReturnType<typeof parseReconciliationLedger>): boolean {
  return (
    parsed.rpcUnavailable ||
    parsed.reconciliationStatus === RECONCILIATION_RPC_TIMEOUT ||
    isReconciliationUnavailableStatus(parsed.reconciliationStatus)
  );
}

describe("reconciliation availability — unavailable status detection", () => {
  it("flags RPC-family and subprocess-failed statuses as unavailable", () => {
    expect(isReconciliationUnavailableStatus("RECONCILIATION_RPC_TIMEOUT")).toBe(true);
    expect(isReconciliationUnavailableStatus("RECONCILIATION_RPC_UNAVAILABLE")).toBe(true);
    expect(isReconciliationUnavailableStatus(RECONCILIATION_SUBPROCESS_FAILED)).toBe(true);
    expect(isReconciliationUnavailableStatus("RECONCILIATION_PASS")).toBe(false);
    expect(isReconciliationUnavailableStatus(null)).toBe(false);
  });
});

describe("reconciliation availability — structured ledgers", () => {
  it("builds a fail-closed timeout ledger naming the bounded RPC-only deadline", () => {
    const ledger = buildReconciliationTimeoutLedger(180);
    expect(ledger.reconciliation_status).toBe(RECONCILIATION_RPC_TIMEOUT);
    expect(ledger.safe_to_use_for_payment_verification).toBe(false);
    expect(ledger.balance_identity_status).toBe("not_run");
    expect(ledger.reconciliation_detail).toContain("180s");
    // (i): the label is RPC-only and explicitly not a facilitator/CDP call.
    expect(ledger.reconciliation_detail).toContain("RPC-only");
    expect(ledger.reconciliation_detail.toLowerCase()).toContain("facilitator");
  });

  it("builds a fail-closed subprocess-failed ledger naming the real cause", () => {
    const fullStderr =
      "Traceback (most recent call last):\n  File x, line 1\nurllib.error.HTTPError: HTTP Error 403: Forbidden";
    const ledger = buildReconciliationSubprocessFailedLedger(
      result({ exitCode: 1, signal: null, stderr: fullStderr }),
    );
    expect(ledger.reconciliation_status).toBe(RECONCILIATION_SUBPROCESS_FAILED);
    expect(ledger.safe_to_use_for_payment_verification).toBe(false);
    expect(ledger.error_class).toBe(RECONCILIATION_SUBPROCESS_FAILED);
    expect(ledger.reconciliation_detail).toContain("exit_code=1");
    // The first non-empty stderr line is the summary...
    expect(ledger.reconciliation_detail).toContain("Traceback");
    // ...but the COMPLETE stderr is persisted so the real cause is recoverable.
    expect(ledger.stderr_full).toBe(fullStderr);
    expect(ledger.stderr_full).toContain("HTTP Error 403: Forbidden");
  });
});

describe("reconciliation availability — materialization never throws (line-147 path)", () => {
  it("timeout → structured timeout ledger", () => {
    const m = materializeReconcileLedger({ result: result({ timedOut: true }), ledgerExists: false, maxTotalRuntimeSeconds: 90 });
    expect(m.kind).toBe("timeout");
    if (m.kind === "use_existing") return;
    expect(m.ledger.reconciliation_status).toBe(RECONCILIATION_RPC_TIMEOUT);
  });

  it("non-zero exit with no ledger → structured subprocess-failed ledger (not a throw)", () => {
    const m = materializeReconcileLedger({
      result: result({ ok: false, exitCode: 2, stderr: "ModuleNotFoundError: web3" }),
      ledgerExists: false,
    });
    expect(m.kind).toBe("subprocess_failed");
    if (m.kind === "use_existing") return;
    expect(m.ledger.reconciliation_status).toBe(RECONCILIATION_SUBPROCESS_FAILED);
    expect(m.ledger.reconciliation_detail).toContain("exit_code=2");
  });

  it("non-zero exit but reconciler wrote its own ledger → use existing", () => {
    const m = materializeReconcileLedger({ result: result({ ok: false, exitCode: 3 }), ledgerExists: true });
    expect(m.kind).toBe("use_existing");
  });

  it("ok → use existing (reconciler produced the real ledger)", () => {
    const m = materializeReconcileLedger({ result: result({ ok: true, exitCode: 0 }), ledgerExists: true });
    expect(m.kind).toBe("use_existing");
  });
});

describe("reconciliation availability — structured verdict flows to BLOCKED", () => {
  it("a subprocess-failed ledger classifies as BLOCKED_RECONCILIATION_UNAVAILABLE, fail-closed", () => {
    const ledger = buildReconciliationSubprocessFailedLedger(result({ exitCode: 1, stderr: "boom" }));
    const parsed = parseReconciliationLedger(ledger as unknown as Record<string, unknown>);
    expect(reconciliationUnavailable(parsed)).toBe(true);

    const classification = classifyX402Settlement({
      probe: {
        paymentAttempted: true,
        paymentBearingHttpRequestCount: 1,
        httpStatus: 200,
        facilitatorReceiptParseStatus: "missing",
        facilitatorReceiptPresent: false,
      },
      reconciliationUnavailable: reconciliationUnavailable(parsed),
      reconciliationStatus: parsed.reconciliationStatus,
      safeToUseForPaymentVerification: parsed.safeToUseForPaymentVerification,
      balanceIdentityStatus: parsed.balanceIdentityStatus,
      binding: null,
    });

    expect(classification.outcome).toBe("BLOCKED_RECONCILIATION_UNAVAILABLE");
    expect(classification.reconciliationStatus).toBe(RECONCILIATION_SUBPROCESS_FAILED);
    expect(classification.safeToUseForPaymentVerification).toBe(false);
  });
});

describe("abort deadline (libuv teardown hardening)", () => {
  it("does not keep the event loop alive and clears cleanly", () => {
    const deadline = startAbortDeadline(30_000);
    // An unref'd timer reports hasRef() === false, so it can never hold the
    // single-fork worker's loop open into teardown (libuv async.c abort).
    const timer = deadline.timer as unknown as { hasRef?: () => boolean };
    if (typeof timer.hasRef === "function") {
      expect(timer.hasRef()).toBe(false);
    }
    expect(deadline.signal.aborted).toBe(false);
    expect(() => {
      deadline.clear();
      deadline.clear();
    }).not.toThrow();
  });
});
