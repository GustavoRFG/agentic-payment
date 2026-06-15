import { describe, expect, it } from "vitest";
import {
  runPaymentIntegrityEngine,
  evaluateTrustScoreCreation,
  ledgerEntryToV1,
  settlementEvidenceToV1,
} from "../../tools/trustforge/settlement-first-v1";
import {
  checkPhase4RichInvariants,
  allPhase4InvariantsPassed,
} from "../../tools/trustforge/phase4-rich-invariants";
import {
  settlementEvidenceFromChainReconciliation,
  missingHeaderSettlementEvidence,
} from "../../tools/trustforge/settlement-evidence";
import type { PaymentAttemptLedgerEntry } from "../../tools/trustforge/payment-attempt-ledger";
import { replayPhase3bSettlements, SETTLEMENT_REPLAY_HASHES } from "../../tools/trustforge/replay-phase3b-settlements";

function baseEntry(overrides: Partial<PaymentAttemptLedgerEntry> = {}): PaymentAttemptLedgerEntry {
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

function reconciledEntry(): PaymentAttemptLedgerEntry {
  const reconciled = settlementEvidenceFromChainReconciliation({
    transactionHash: SETTLEMENT_REPLAY_HASHES[0],
    amountDecimal: "0.001125",
    amountAtomic: "1125",
    payer: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
    payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
    mappingConfidence: "medium",
  });
  return baseEntry({
    chainReconciledSettlementEvidence: reconciled,
    actualSpendUsdc: "0.001125",
    actualSpendSource: "chain_reconciliation",
  });
}

describe("PaymentIntegrityEngine v1", () => {
  it("passes when settlement evidence pass + semantic evaluation pass", () => {
    const entry = ledgerEntryToV1(reconciledEntry(), {
      noPaymentMode: true,
      blockNumber: 47342247,
    });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: entry,
      semanticEvaluationStatus: "pass",
      expectedSettlementHashes: [...SETTLEMENT_REPLAY_HASHES],
    });
    expect(result.pass).toBe(true);
    expect(result.status).toBe("pass");
  });

  it("fails when settlement missing", () => {
    const entry = ledgerEntryToV1(baseEntry(), { noPaymentMode: true });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: entry,
      semanticEvaluationStatus: "pass",
    });
    expect(result.pass).toBe(false);
  });

  it("fails when settlement fail", () => {
    const entry = ledgerEntryToV1(baseEntry(), { noPaymentMode: true });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: entry,
      semanticEvaluationStatus: "pass",
    });
    expect(result.settlement_evidence_status).not.toBe("pass");
  });

  it("fails when semantic evaluation missing", () => {
    const entry = ledgerEntryToV1(reconciledEntry(), { noPaymentMode: true });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: entry,
      semanticEvaluationStatus: "not_executed",
      expectedSettlementHashes: [...SETTLEMENT_REPLAY_HASHES],
    });
    expect(result.pass).toBe(false);
  });

  it("fails when semantic evaluation fail", () => {
    const entry = ledgerEntryToV1(reconciledEntry(), { noPaymentMode: true });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: entry,
      semanticEvaluationStatus: "fail",
      expectedSettlementHashes: [...SETTLEMENT_REPLAY_HASHES],
    });
    expect(result.pass).toBe(false);
  });

  it("blocks when payment header sent in no-payment mode", () => {
    const entry = ledgerEntryToV1(reconciledEntry(), { noPaymentMode: true });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: {
        ...entry,
        payment_header_sent: true,
        safety: { ...entry.safety, payment_bearing_http_request_count: 1 },
      },
      semanticEvaluationStatus: "pass",
    });
    expect(result.status).toBe("blocked");
  });

  it("blocks when wallet loaded in no-payment mode", () => {
    const entry = ledgerEntryToV1(reconciledEntry(), { noPaymentMode: true });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: { ...entry, wallet_loaded: true },
      semanticEvaluationStatus: "pass",
    });
    expect(result.status).toBe("blocked");
  });

  it("blocks when retry used in no-payment mode", () => {
    const entry = ledgerEntryToV1(reconciledEntry(), { noPaymentMode: true });
    const result = runPaymentIntegrityEngine({
      ledgerEntry: {
        ...entry,
        safety: { ...entry.safety, retry_used: true },
      },
      semanticEvaluationStatus: "pass",
    });
    expect(result.status).toBe("blocked");
  });
});

describe("TrustScore blocking v1", () => {
  const passIntegrity = () =>
    runPaymentIntegrityEngine({
      ledgerEntry: ledgerEntryToV1(reconciledEntry(), { noPaymentMode: true }),
      semanticEvaluationStatus: "pass",
      expectedSettlementHashes: [...SETTLEMENT_REPLAY_HASHES],
    });

  it("allows TrustScore when semantic pass + payment pass", () => {
    const gate = evaluateTrustScoreCreation({
      paymentIntegrity: passIntegrity(),
      semanticEvaluationStatus: "pass",
    });
    expect(gate.trust_score_created).toBe(true);
  });

  it("blocks when semantic pass + payment missing", () => {
    const gate = evaluateTrustScoreCreation({
      paymentIntegrity: runPaymentIntegrityEngine({
        ledgerEntry: ledgerEntryToV1(baseEntry(), { noPaymentMode: true }),
        semanticEvaluationStatus: "pass",
      }),
      semanticEvaluationStatus: "pass",
    });
    expect(gate.trust_score_created).toBe(false);
    if (gate.trust_score_created === false) {
      expect(gate.blocked_reason).toMatch(/payment_integrity/);
    }
  });

  it("blocks when semantic pass + payment fail", () => {
    const gate = evaluateTrustScoreCreation({
      paymentIntegrity: runPaymentIntegrityEngine({
        ledgerEntry: ledgerEntryToV1(baseEntry(), { noPaymentMode: true }),
        semanticEvaluationStatus: "pass",
      }),
      semanticEvaluationStatus: "pass",
    });
    expect(gate.trust_score_created).toBe(false);
  });

  it("blocks when semantic missing + payment pass", () => {
    const gate = evaluateTrustScoreCreation({
      paymentIntegrity: passIntegrity(),
      semanticEvaluationStatus: "not_executed",
    });
    expect(gate.trust_score_created).toBe(false);
    if (gate.trust_score_created === false) {
      expect(gate.blocked_reason).toMatch(/semantic/);
    }
  });

  it("blocks when semantic fail + payment pass", () => {
    const gate = evaluateTrustScoreCreation({
      paymentIntegrity: passIntegrity(),
      semanticEvaluationStatus: "fail",
    });
    expect(gate.trust_score_created).toBe(false);
  });
});

describe("Phase 4 rich invariants RICH-001..010", () => {
  it("passes all invariants for offline Phase 3B replay", async () => {
    const replay = await replayPhase3bSettlements();
    expect(replay.reconciled_settlement_count).toBe(2);
    expect(replay.wallet_loaded).toBe(false);
    expect(replay.payment_header_sent).toBe(false);
    expect(replay.new_transaction_hash_created).toBe(false);
    expect(allPhase4InvariantsPassed(replay.invariants)).toBe(true);
  });

  it("ledger invariants: zero payment-bearing requests in no-payment replay", async () => {
    const replay = await replayPhase3bSettlements();
    const rich007 = replay.invariants.find((i) => i.id === "RICH-007");
    expect(rich007?.passed).toBe(true);
  });

  it("settlementEvidenceToV1 maps chain reconciled evidence", () => {
    const legacy = settlementEvidenceFromChainReconciliation({
      transactionHash: SETTLEMENT_REPLAY_HASHES[0],
      amountDecimal: "0.001125",
      amountAtomic: "1125",
      payer: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
      payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
    });
    const v1 = settlementEvidenceToV1({
      legacy,
      blockNumber: 47342247,
      quoteUsdc: "0.001125",
      quoteChainId: 8453,
      evidenceSource: "offline_replay",
    });
    expect(v1.schema_version).toBe("settlement_evidence.v1");
    expect(v1.status).toBe("pass");
    expect(v1.tx_hash).toBe(SETTLEMENT_REPLAY_HASHES[0]);
  });
});

describe("Phase 4 invariant checker unit", () => {
  it("detects RICH-001 violation when TrustScore created without payment pass", () => {
    const results = checkPhase4RichInvariants({
      noPaymentMode: true,
      paymentIntegrity: {
        schema_version: "payment_integrity_result.v1",
        status: "fail",
        pass: false,
        checked_at: "2026-06-15T00:00:00.000Z",
        reasons: [],
        settlement_evidence_status: "fail",
        semantic_evaluation_status: "pass",
        invariants: {
          no_trust_score_without_settlement: true,
          no_trust_score_without_semantic_pass: true,
          no_payment_header_in_no_payment_mode: true,
          no_wallet_load_in_no_payment_mode: true,
          no_retry_in_no_payment_mode: true,
          settlement_hash_matches_ledger: null,
        },
      },
      semanticEvaluationStatus: "pass",
      trustScoreCreated: true,
      ledgerEntries: [],
      expectedSettlementHashes: [...SETTLEMENT_REPLAY_HASHES],
      newTransactionHashes: [],
    });
    expect(results.find((r) => r.id === "RICH-001")?.passed).toBe(false);
  });
});
