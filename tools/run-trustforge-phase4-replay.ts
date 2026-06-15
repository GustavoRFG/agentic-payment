/**
 * run-trustforge-phase4-replay — offline Phase 3B settlement-first replay.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { extractTxExplainerClaims } from "./trustforge/extract-tx-explainer-claims";
import { verifyTxExplainerFacts } from "./trustforge/verify-tx-explainer-facts";
import {
  buildPaymentAttemptLedger,
  runIdFromDir,
  type PaymentAttemptLedgerEntry,
} from "./trustforge/payment-attempt-ledger";
import {
  applyPaymentIntegrityToEntry,
  evaluatePaymentIntegrity,
} from "./trustforge/payment-integrity-engine";
import {
  evaluateRichProbeEligibility,
  assertRichProbeInvariants,
  positiveScoreBlockedReason,
} from "./trustforge/rich-probe-invariants";
import {
  missingHeaderSettlementEvidence,
  settlementEvidenceFromChainReconciliation,
} from "./trustforge/settlement-evidence";
import type { UsdcSettlementReconciliation } from "./trustforge/reconcile-usdc-settlements";
import type { PaymentAttemptMappingReport } from "./trustforge/map-rich-payment-attempts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = join(REPO, "trustforge", "evidence", "rich_tx_explainer_probe");
const PHASE3B_RUN = join(
  "D:\\trustforge",
  "artifacts",
  "runs",
  "rich-tx-explainer-phase3b-reconciliation",
  "run_20260615_014637",
);
const TARGET_TX =
  "0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4";
const WALLET = "0x4cf373373aba89b9bbd5a428fd71831bcbc7d0c1";
const PAYTO = "0x43a2a720cd0911690c248075f4a29a5e7716f758";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export interface Phase4ReplayResult {
  readonly ledger: ReturnType<typeof buildPaymentAttemptLedger>;
  readonly semanticEvaluationStatus: "incomplete";
  readonly factComposite: number;
  readonly wrongClaims: number;
  readonly trustScoreEligible: boolean;
  readonly positiveScoreBlockedReason: string | null;
  readonly invariantViolations: readonly string[];
  readonly reconciledSettlementCount: number;
  readonly actualTotalSpendUsdc: string | null;
}

export async function runPhase4Replay(): Promise<Phase4ReplayResult> {
  const reconciliation = await readJson<UsdcSettlementReconciliation>(
    join(EVIDENCE, "reconciled_settlements.json"),
  );
  const mapping = await readJson<PaymentAttemptMappingReport>(
    join(EVIDENCE, "payment_attempt_mapping.json"),
  );
  const groundTruth = await readJson<import("./trustforge/build-tx-ground-truth").TxGroundTruth>(
    join(
      "D:\\trustforge",
      "artifacts",
      "runs",
      "rich-tx-explainer",
      "run_20260614_214953",
      "06_onchain_ground_truth.json",
    ),
  );
  const seller = await readJson<{ body: unknown }>(
    join(
      "D:\\trustforge",
      "artifacts",
      "runs",
      "rich-tx-explainer",
      "run_20260614_214953",
      "10_seller_response.json",
    ),
  );

  const eventsByHash = new Map(
    reconciliation.events
      .filter((event) => event.candidate_match === "zapper_rich_tx_explainer")
      .map((event) => [event.tx_hash.toLowerCase(), event]),
  );

  const entries: PaymentAttemptLedgerEntry[] = mapping.attempts.map((attempt) => {
    const runId = runIdFromDir(attempt.run_dir);
    const mappedHash = attempt.mapped_settlement_tx_hash?.toLowerCase() ?? null;
    const event = mappedHash ? eventsByHash.get(mappedHash) : undefined;
    const saved = missingHeaderSettlementEvidence({
      paymentMetadataPresent: false,
      paymentResponseHeaderPresent: false,
      quoteUsdc: "0.001125",
    });
    const reconciled = event
      ? settlementEvidenceFromChainReconciliation({
          transactionHash: event.tx_hash,
          amountDecimal: event.amount_decimal,
          amountAtomic: event.amount_atomic,
          payer: event.from,
          payTo: event.to,
          mappingConfidence: attempt.mapped_settlement_confidence as "medium",
          evidencePaths: [join(EVIDENCE, "reconciled_settlements.json")],
        })
      : null;

    const base: PaymentAttemptLedgerEntry = {
      attemptId: `${runId}__attempt_1`,
      runId,
      serviceId: "zapper_tx_explainer",
      endpoint: "https://public.zapper.xyz/x402/transaction-details",
      method: "POST",
      targetTaskId: "rich_tx_explainer__base_usdc_payment_tx_v1",
      targetTxHash: TARGET_TX,
      quoteUsdc: "0.001125",
      capUsdc: "0.10",
      paymentBearingHttpRequestCount: attempt.payment_bearing_http_request_count,
      walletFingerprint: "49b14ebd8f578d41",
      sellerResponseCaptured: attempt.seller_response_captured,
      sellerResponseBodySha256: attempt.seller_response_body_sha256,
      savedSettlementEvidence: saved,
      chainReconciledSettlementEvidence: reconciled,
      actualSpendUsdc: reconciled?.amountDecimal ?? null,
      actualSpendSource: reconciled ? "chain_reconciliation" : null,
      finalPaymentIntegrity: "not_executed",
      createdAtUtc: `${runId.replace("run_", "").slice(0, 8)}T${runId.replace("run_", "").slice(9).replace(/(\d{2})(?=\d{2}$)/, "$1:")}:00.000Z`,
    };
    return applyPaymentIntegrityToEntry(base, { chainReconciliationAttempted: true });
  });

  const ledger = buildPaymentAttemptLedger(entries, "zapper_tx_explainer");
  const claims = extractTxExplainerClaims({
    body: seller.body,
    expectedChainId: groundTruth.chain_id,
  });
  const facts = verifyTxExplainerFacts({ groundTruth, claims });

  const semanticEvaluationStatus = facts.passed ? "pass" : "incomplete";
  const paymentIntegrityStatuses = entries.map((entry) => entry.finalPaymentIntegrity);
  const aggregatePaymentIntegrity = paymentIntegrityStatuses.every((s) => s === "pass")
    ? "pass"
    : paymentIntegrityStatuses.some((s) => s === "pass")
      ? "ambiguous"
      : "fail";

  const eligibility = evaluateRichProbeEligibility({
    paymentIntegrityStatus: aggregatePaymentIntegrity,
    semanticEvaluationStatus,
  });

  const sampleEntry = entries[0];
  const integrity = sampleEntry
    ? evaluatePaymentIntegrity({
        entry: sampleEntry,
        chainReconciliationAttempted: true,
      })
    : null;

  const invariant = assertRichProbeInvariants({
    quote_usdc: "0.001125",
    actual_spend_usdc: sampleEntry?.actualSpendUsdc ?? null,
    actual_total_spend_usdc: ledger.actual_total_spend_usdc,
    transaction_hash: sampleEntry?.chainReconciledSettlementEvidence?.transactionHash ?? null,
    transaction_hash_source: "chain_reconciliation",
    settlement_evidence_status: "chain_reconciled",
    payment_integrity_status: sampleEntry?.finalPaymentIntegrity ?? "not_executed",
    payment_bearing_http_request_count: 1,
    trust_score_rich_created: false,
    semantic_evaluation_status: semanticEvaluationStatus,
    onchain_payment_verification_status: "not_executed",
    chain_reconciliation_attempted: true,
    http_status: 200,
  });

  // Block positive score even when two attempts pass payment integrity
  const trustScoreEligible = eligibility.trustScoreEligible;

  return {
    ledger,
    semanticEvaluationStatus: "incomplete",
    factComposite: facts.composite,
    wrongClaims: facts.wrong_claims.length,
    trustScoreEligible,
    positiveScoreBlockedReason: positiveScoreBlockedReason(eligibility),
    invariantViolations: invariant.violations,
    reconciledSettlementCount: ledger.reconciled_settlement_count,
    actualTotalSpendUsdc: ledger.actual_total_spend_usdc,
  };
}

export { WALLET, PAYTO, PHASE3B_RUN };
