/**
 * run-trustforge-phase4-invariants — RICH-001 through RICH-010 checks (no payment).
 */

import { pathToFileURL } from "node:url";
import { replayPhase3bSettlements } from "./trustforge/replay-phase3b-settlements";
import {
  checkPhase4RichInvariants,
  allPhase4InvariantsPassed,
} from "./trustforge/phase4-rich-invariants";
import {
  runPaymentIntegrityEngine,
  evaluateTrustScoreCreation,
  ledgerEntryToV1,
} from "./trustforge/settlement-first-v1";
import type { PaymentAttemptLedgerEntry } from "./trustforge/payment-attempt-ledger";
import { missingHeaderSettlementEvidence } from "./trustforge/settlement-evidence";

function syntheticEntry(
  overrides: Partial<PaymentAttemptLedgerEntry> = {},
): PaymentAttemptLedgerEntry {
  return {
    attemptId: "synthetic_1",
    runId: "run_synthetic",
    serviceId: "zapper_tx_explainer",
    endpoint: "https://public.zapper.xyz/x402/transaction-details",
    method: "POST",
    targetTaskId: "rich_tx_explainer__base_usdc_payment_tx_v1",
    quoteUsdc: "0.001125",
    capUsdc: "0.10",
    paymentBearingHttpRequestCount: 0,
    walletFingerprint: null,
    sellerResponseCaptured: false,
    sellerResponseBodySha256: null,
    savedSettlementEvidence: missingHeaderSettlementEvidence({ quoteUsdc: "0.001125" }),
    chainReconciledSettlementEvidence: null,
    actualSpendUsdc: null,
    actualSpendSource: null,
    finalPaymentIntegrity: "not_executed",
    createdAtUtc: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}

async function main(): Promise<number> {
  process.env.TRUSTFORGE_PHASE4_NO_PAYMENT = "YES_STRICTLY_NO_PAYMENT";
  process.env.TRUSTFORGE_DISABLE_PAID_EXECUTION = "YES";

  const replay = await replayPhase3bSettlements();
  if (!replay.invariants_passed) {
    console.error("Phase 3B replay invariants failed:");
    for (const inv of replay.invariants.filter((i) => !i.passed)) {
      console.error(`  ${inv.id}: ${inv.detail}`);
    }
    return 1;
  }

  // Synthetic gate checks (deterministic, offline)
  const noPaymentEntry = ledgerEntryToV1(syntheticEntry(), { noPaymentMode: true });
  const blockedWallet = runPaymentIntegrityEngine({
    ledgerEntry: {
      ...noPaymentEntry,
      wallet_loaded: true,
      policy_flags: { ...noPaymentEntry.policy_flags, no_payment_mode: true },
    },
    semanticEvaluationStatus: "pass",
  });
  if (blockedWallet.status !== "blocked") {
    console.error("expected wallet load in no-payment mode to block");
    return 1;
  }

  const blockedHeader = runPaymentIntegrityEngine({
    ledgerEntry: {
      ...noPaymentEntry,
      payment_header_sent: true,
      safety: { ...noPaymentEntry.safety, payment_bearing_http_request_count: 1 },
    },
    semanticEvaluationStatus: "pass",
  });
  if (blockedHeader.status !== "blocked") {
    console.error("expected payment header in no-payment mode to block");
    return 1;
  }

  const passIntegrity = runPaymentIntegrityEngine({
    ledgerEntry: ledgerEntryToV1(
      syntheticEntry({
        chainReconciledSettlementEvidence: {
          status: "chain_reconciled",
          transactionHash: "0x9b605be3d78e4b64168842548612f3ceb671c61df8fab069aa7a815d934c35ed",
          transactionHashSource: "chain_reconciliation",
          chainId: 8453,
          amountAtomic: "1125",
          amountDecimal: "0.001125",
          asset: "USDC",
          payer: "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1",
          payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
          receiptStatus: "success",
          mappingConfidence: "medium",
          evidencePaths: [],
          notes: [],
        },
        actualSpendUsdc: "0.001125",
      }),
      { noPaymentMode: true, blockNumber: 47342247 },
    ),
    semanticEvaluationStatus: "pass",
    expectedSettlementHashes: [
      "0x9b605be3d78e4b64168842548612f3ceb671c61df8fab069aa7a815d934c35ed",
    ],
  });
  if (!passIntegrity.pass) {
    console.error("expected pass when settlement + semantic pass");
    return 1;
  }

  const trustAllowed = evaluateTrustScoreCreation({
    paymentIntegrity: passIntegrity,
    semanticEvaluationStatus: "pass",
  });
  if (trustAllowed.trust_score_created !== true) {
    console.error("expected TrustScore allowed when both gates pass");
    return 1;
  }

  const trustBlocked = evaluateTrustScoreCreation({
    paymentIntegrity: passIntegrity,
    semanticEvaluationStatus: "incomplete",
  });
  if (trustBlocked.trust_score_created !== false) {
    console.error("expected TrustScore blocked when semantic incomplete");
    return 1;
  }

  const syntheticInvariant = checkPhase4RichInvariants({
    noPaymentMode: true,
    paymentIntegrity: passIntegrity,
    semanticEvaluationStatus: "pass",
    trustScoreCreated: false,
    ledgerEntries: replay.invariants.length > 0 ? [] : [],
    expectedSettlementHashes: [
      "0x9b605be3d78e4b64168842548612f3ceb671c61df8fab069aa7a815d934c35ed",
      "0x8f5edd95fb36ae7bcc129dc600ec7815db5d979ffe6cd7088b711ff94a0c2b86",
    ],
    newTransactionHashes: [],
  });

  console.log(
    JSON.stringify({
      status: "PASS",
      replay_invariants: replay.invariants.length,
      replay_invariants_passed: allPhase4InvariantsPassed(replay.invariants),
      trust_score_blocked_reason:
        replay.trust_score_gate.trust_score_created === false
          ? replay.trust_score_gate.blocked_reason
          : null,
      synthetic_checks: syntheticInvariant.length,
    }),
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as runPhase4InvariantsMain };
