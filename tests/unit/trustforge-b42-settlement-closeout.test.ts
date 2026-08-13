/**
 * B.4.2 — settlement closeout audit helpers (synthetic only).
 * NO REAL SIGNER. NO REAL PAYMENT.
 */

import { describe, expect, it } from "vitest";

import {
  createFetchPaymentBearingHttpTransport,
  createInjectedPaymentBearingHttpTransport,
} from "../../tools/trustforge/buyer-payment-bearing-http-transport";
import {
  createRunnerState,
  evaluateRunnerCrashRecovery,
  transitionRunnerState,
} from "../../tools/trustforge/thin-mainnet-runner-state";
import { createServer } from "node:http";

const NOW = new Date("2026-08-13T03:00:00.000Z");
const FAKE_TX =
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("B.4.2 closeout safety", () => {
  it("crash after CONFIRMED is terminal; may_retry_send=false", () => {
    let record = createRunnerState("run_b42", NOW);
    record = transitionRunnerState(record, "CANDIDATE_READY", NOW);
    record = transitionRunnerState(record, "HUMAN_DECISION_PENDING", NOW);
    record = transitionRunnerState(record, "HUMAN_APPROVED", NOW, {
      human_decision_id: "paydec_x",
    });
    // Fast-forward through allowed path to CONFIRMED is large; use terminal via
    // simulating persisted CONFIRMED state object.
    const confirmed = {
      ...record,
      state: "CONFIRMED" as const,
      updated_at: NOW.toISOString(),
    };
    const recovery = evaluateRunnerCrashRecovery({ record: confirmed });
    expect(recovery.disposition).toBe("TERMINAL");
    expect(recovery.may_retry_send).toBe(false);
    expect(recovery.may_resign).toBe(false);
  });

  it("crash after SEND_COMMITTED_NO_RETRY is reconcile-only; no resend", () => {
    let record = createRunnerState("run_b42b", NOW);
    record = transitionRunnerState(record, "CANDIDATE_READY", NOW);
    record = transitionRunnerState(record, "HUMAN_DECISION_PENDING", NOW);
    record = transitionRunnerState(record, "HUMAN_APPROVED", NOW, {
      human_decision_id: "paydec_y",
    });
    const committed = {
      ...record,
      state: "SEND_COMMITTED_NO_RETRY" as const,
      updated_at: NOW.toISOString(),
    };
    const recovery = evaluateRunnerCrashRecovery({ record: committed });
    expect(recovery.disposition).toBe("AMBIGUOUS_RECONCILE_ONLY");
    expect(recovery.may_retry_send).toBe(false);
  });

  it("transport extracts sanitized facilitator receipt before body truncation risk", async () => {
    const server = createServer((_req, res) => {
      res.setHeader(
        "PAYMENT-RESPONSE",
        Buffer.from(
          JSON.stringify({
            success: true,
            transaction: FAKE_TX,
            network: "eip155:8453",
          }),
        ).toString("base64"),
      );
      res.statusCode = 200;
      res.end(`{"ok":true,"pad":"${"x".repeat(400)}"}`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const transport = createFetchPaymentBearingHttpTransport();
    const outcome = await transport.invokeOnce({
      url: `http://127.0.0.1:${addr.port}/x`,
      method: "GET",
      headers: { Accept: "application/json" },
      body: null,
    });
    await new Promise<void>((r) => server.close(() => r()));
    expect(outcome.kind).toBe("response_observed");
    if (outcome.kind !== "response_observed") return;
    expect(outcome.facilitator_receipt?.transactionHash?.toLowerCase()).toBe(
      FAKE_TX,
    );
    expect(outcome.status).toBe(200);
  });

  it("injected transport still forbids second payment-bearing invoke", async () => {
    const transport = createInjectedPaymentBearingHttpTransport(async () => ({
      kind: "response_observed",
      status: 200,
      redirected: false,
      body_text: "{}",
      observed_at: NOW.toISOString(),
    }));
    await transport.invokeOnce({
      url: "http://127.0.0.1/x",
      method: "GET",
      headers: {},
      body: null,
    });
    await expect(
      transport.invokeOnce({
        url: "http://127.0.0.1/x",
        method: "GET",
        headers: {},
        body: null,
      }),
    ).rejects.toThrow(/SECOND_PAYMENT_BEARING_REQUEST/);
  });
});
