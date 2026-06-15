import { describe, expect, it } from "vitest";
import { evaluatePaymentIntegrity, applyPaymentIntegrityToEntry } from "../../tools/trustforge/payment-integrity-engine";
import {
  evaluateRichProbeEligibility,
  assertRichProbeInvariants,
  positiveScoreBlockedReason,
} from "../../tools/trustforge/rich-probe-invariants";
import {
  missingHeaderSettlementEvidence,
  settlementEvidenceFromChainReconciliation,
} from "../../tools/trustforge/settlement-evidence";
import type { PaymentAttemptLedgerEntry } from "../../tools/trustforge/payment-attempt-ledger";
import { runPhase4Replay } from "../../tools/run-trustforge-phase4-replay";
import { checkPhase3bEnvSafety } from "../../tools/run-trustforge-rich-tx-explainer-phase3b";

function baseEntry(
  overrides: Partial<PaymentAttemptLedgerEntry> = {},
): PaymentAttemptLedgerEntry {
  return {
    attemptId: "attempt_1",
    runId: "run_test",
    serviceId: "zapper_tx_explainer",
    endpoint: "https://public.zapper.xyz/x402/transaction-details",
    method: "POST",
    targetTaskId: "rich_tx_explainer__base_usdc_payment_tx_v1",
    quoteUsdc: "0.001125",
    capUsdc: "0.10",
    paymentBearingHttpRequestCount: 1,
    walletFingerprint: "abc",
    sellerResponseCaptured: true,
    sellerResponseBodySha256: "1674d473",
    savedSettlementEvidence: missingHeaderSettlementEvidence({ quoteUsdc: "0.001125" }),
    chainReconciledSettlementEvidence: null,
    actualSpendUsdc: null,
    actualSpendSource: null,
    finalPaymentIntegrity: "not_executed",
    createdAtUtc: "2026-06-14T21:49:56.691Z",
    ...overrides,
  };
}

describe("payment integrity engine", () => {
  it("requires reconciliation when header tx hash missing", () => {
    const result = evaluatePaymentIntegrity({
      entry: baseEntry(),
      chainReconciliationAttempted: false,
    });
    expect(result.status).toBe("ambiguous");
    expect(result.onchainReconciliationRequired).toBe(true);
    expect(result.actualSpendUsdc).toBeNull();
  });

  it("passes when chain reconciliation proves settlement", () => {
    const reconciled = settlementEvidenceFromChainReconciliation({
      transactionHash: "0x" + "a".repeat(64),
      amountDecimal: "0.001125",
      amountAtomic: "1125",
      payer: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
      payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
      mappingConfidence: "medium",
    });
    const entry = applyPaymentIntegrityToEntry(
      baseEntry({
        chainReconciledSettlementEvidence: reconciled,
        actualSpendUsdc: "0.001125",
        actualSpendSource: "chain_reconciliation",
      }),
      { chainReconciliationAttempted: true },
    );
    expect(entry.finalPaymentIntegrity).toBe("pass");
  });

  it("does not treat HTTP 200 alone as payment integrity pass", () => {
    const result = evaluatePaymentIntegrity({ entry: baseEntry(), chainReconciliationAttempted: false });
    expect(result.status).not.toBe("pass");
  });
});

describe("rich probe eligibility", () => {
  it("blocks TrustScore when semantic incomplete even if payment pass", () => {
    const eligibility = evaluateRichProbeEligibility({
      paymentIntegrityStatus: "pass",
      semanticEvaluationStatus: "incomplete",
    });
    expect(eligibility.trustScoreEligible).toBe(false);
    expect(positiveScoreBlockedReason(eligibility)).toContain("semantic_evaluation:incomplete");
  });

  it("blocks TrustScore when payment integrity ambiguous", () => {
    const eligibility = evaluateRichProbeEligibility({
      paymentIntegrityStatus: "ambiguous",
      semanticEvaluationStatus: "pass",
    });
    expect(eligibility.trustScoreEligible).toBe(false);
  });
});

describe("rich probe invariants", () => {
  it("catches quote copied as spend without evidence", () => {
    const result = assertRichProbeInvariants({
      quote_usdc: "0.001125",
      actual_spend_usdc: "0.001125",
      transaction_hash: null,
      transaction_hash_source: null,
      settlement_evidence_status: "missing_header_tx_hash",
      payment_integrity_status: "ambiguous",
      payment_bearing_http_request_count: 1,
      trust_score_rich_created: false,
      semantic_evaluation_status: "incomplete",
    });
    expect(result.passed).toBe(false);
  });

  it("never loads wallet in phase4 safety check", () => {
    expect(checkPhase3bEnvSafety({}).status).toBe("PASS_NO_PAYMENT_FLAGS");
  });
});

describe("Phase 3B replay", () => {
  it("finds two reconciled settlements and blocks positive score", async () => {
    const replay = await runPhase4Replay();
    expect(replay.reconciledSettlementCount).toBe(2);
    expect(replay.actualTotalSpendUsdc).toBe("0.00225");
    expect(replay.semanticEvaluationStatus).toBe("incomplete");
    expect(replay.trustScoreEligible).toBe(false);
    expect(replay.wrongClaims).toBe(0);
    expect(replay.invariantViolations).toEqual([]);
  });
});
