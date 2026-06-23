/**
 * x402-classify-runner — shared read-only reconcile + three-outcome classify.
 */

import { existsSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import {
  buildX402ReconcileArgs,
  classifyX402Settlement,
  confirmX402SettlementBinding,
  inferNoNewOutboundTransfer,
  parseReconciliationLedger,
} from "./x402-settlement-classify";
import { runBoundedPythonReconcile } from "./bounded-reconcile-spawn";
import type { FacilitatorReceiptArtifact } from "./facilitator-settlement-receipt";
import { validateLedgerIdentity } from "./ledger-reuse-validation";
import { assertProfileEnvBeforeSettlement, type X402SettlementProfile } from "./x402-settlement-profile";
import { bindingConfirmsSettlement, resolveBindingUpperBoundUtc } from "./settlement-run-binding";
import type { SettlementIntent } from "./settlement-run-binding";
import { readJsonFile } from "./bom-safe-json";

export interface X402ClassifyOptions {
  readonly runDir: string;
  readonly profile: X402SettlementProfile;
  readonly repoRoot: string;
  readonly reuseExistingLedger?: boolean;
  readonly rpcRequestTimeoutSeconds?: number;
  readonly rpcMaxRetries?: number;
  readonly maxTotalRuntimeSeconds?: number;
}

async function findSettlementIntent(runDir: string): Promise<SettlementIntent | null> {
  if (!existsSync(runDir)) return null;
  const intentFile = readdirSync(runDir).find((name) => name.startsWith("settlement_intent_"));
  if (!intentFile) return null;
  return readJsonFile<SettlementIntent>(join(runDir, intentFile));
}

async function loadFacilitatorReceipt(
  runDir: string,
  attemptId: string | null,
): Promise<FacilitatorReceiptArtifact | null> {
  if (!attemptId) return null;
  const path = join(runDir, `facilitator_receipt_${attemptId}.json`);
  if (!existsSync(path)) return null;
  return readJsonFile<FacilitatorReceiptArtifact>(path);
}

function receiptToBindingInput(artifact: FacilitatorReceiptArtifact | null) {
  if (!artifact) return null;
  return {
    parseStatus: artifact.parse_status,
    source: artifact.source,
    rawHeaderName: null,
    transactionHash: artifact.transaction_hash,
    network: artifact.network,
    payer: artifact.payer,
    payTo: artifact.pay_to,
    asset: artifact.asset,
    amountAtomic: artifact.amount_atomic,
    facilitator: artifact.facilitator,
    settledAtUtc: artifact.settled_at_utc,
    parseErrorClass: artifact.parse_error_class,
  };
}

export async function runX402Classify(options: X402ClassifyOptions): Promise<{
  readonly exitCode: number;
  readonly lines: string[];
}> {
  assertProfileEnvBeforeSettlement(options.profile);
  const {
    runDir,
    profile,
    repoRoot,
    reuseExistingLedger = false,
    rpcRequestTimeoutSeconds = 20,
    rpcMaxRetries = 2,
    maxTotalRuntimeSeconds = 180,
  } = options;

  const selected = await readJsonFile<DiscoveredSelectedCandidate>(
    join(runDir, "selected_candidate.json"),
  );
  const executionPath = join(runDir, "settlement_probe", "01_execution.json");
  if (!existsSync(executionPath)) {
    throw new Error("BLOCKED_NO_SETTLEMENT_EXECUTION: run human settlement probe first");
  }
  const execution = await readJsonFile<{
    paymentAttempted: boolean;
    paymentBearingHttpRequestCount: number;
    httpStatus: number | null;
    balanceBeforeUsdc?: string;
    facilitatorTransactionHash?: string | null;
    facilitatorReceiptPath?: string | null;
    facilitatorReceiptParseStatus?: string | null;
    intentPath?: string;
    attemptId?: string;
    executed_at_utc?: string;
    request_completed_at_utc?: string;
  }>(executionPath);

  const reconcileDir = join(runDir, profile.reconciliationDirName);
  await mkdir(reconcileDir, { recursive: true });
  const ledgerPath = join(reconcileDir, "onchain_settlement_ledger.json");
  let reconcileTimedOut = false;

  if (!reuseExistingLedger || !existsSync(ledgerPath)) {
    const args = [
      "tools/run-onchain-settlement-reconciliation.py",
      ...buildX402ReconcileArgs(profile, selected, execution.balanceBeforeUsdc, {
        rpcRequestTimeoutSeconds,
        rpcMaxRetries,
        maxTotalRuntimeSeconds,
      }),
      "--output-dir",
      reconcileDir,
    ];
    const result = runBoundedPythonReconcile({
      repoRoot,
      pythonArgs: args,
      maxTotalRuntimeSeconds,
    });
    if (result.timedOut) {
      reconcileTimedOut = true;
      await writeFile(
        ledgerPath,
        `${JSON.stringify(
          {
            schema_name: "trustforge_onchain_settlement_ledger",
            schema_version: "0.2.0",
            reconciliation_status: "RECONCILIATION_RPC_TIMEOUT",
            safe_to_use_for_payment_verification: false,
            balance_identity_status: "not_run",
            error_class: "RECONCILIATION_RPC_TIMEOUT",
            reconciliation_detail: "TypeScript child process deadline exceeded",
            settlements: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
    } else if (!result.ok && !existsSync(ledgerPath)) {
      throw new Error(result.stderr || "reconciliation failed");
    }
  } else {
    console.log(`Reusing existing ledger: ${ledgerPath}`);
    const existingLedger = await readJsonFile<Record<string, unknown>>(ledgerPath);
    const identity = validateLedgerIdentity(existingLedger, {
      network: profile.caip2,
      chainId: profile.chainId,
      buyer: profile.buyerWallet,
      asset: selected.asset ?? profile.usdcContract,
    });
    if (!identity.ok) {
      throw new Error(identity.reason ?? "REUSE_LEDGER_IDENTITY_MISMATCH");
    }
  }

  const ledger = await readJsonFile<Record<string, unknown>>(ledgerPath);
  const parsed = parseReconciliationLedger(ledger, profile);

  let bindingResult: ReturnType<typeof confirmX402SettlementBinding> | null = null;
  let intent: SettlementIntent | null = null;
  if (execution.intentPath && existsSync(execution.intentPath)) {
    intent = await readJsonFile<SettlementIntent>(execution.intentPath);
  } else {
    intent = await findSettlementIntent(runDir);
  }

  const upperBoundUtc = resolveBindingUpperBoundUtc({
    executionEndUtc: execution.request_completed_at_utc ?? execution.executed_at_utc ?? null,
    classificationStartedUtc: new Date().toISOString(),
  });

  const receiptArtifact = await loadFacilitatorReceipt(
    runDir,
    intent?.attempt_id ?? execution.attemptId ?? null,
  );
  const facilitatorReceipt = receiptToBindingInput(receiptArtifact);

  if (intent && !reconcileTimedOut && parsed.reconciliationStatus !== "RECONCILIATION_RPC_TIMEOUT") {
    bindingResult = confirmX402SettlementBinding({
      intent,
      ledger,
      facilitatorReceipt,
      facilitatorReportedHash:
        facilitatorReceipt?.transactionHash ?? execution.facilitatorTransactionHash ?? null,
      upperBoundUtc,
    });
    await writeFile(
      join(runDir, `settlement_binding_${intent.attempt_id}.json`),
      `${JSON.stringify(bindingResult.binding, null, 2)}\n`,
      "utf8",
    );
  }

  const binding = bindingResult?.binding ?? null;
  const bindingConfirmed = binding ? bindingConfirmsSettlement(binding) : false;
  const rpcUnavailable =
    parsed.rpcUnavailable ||
    reconcileTimedOut ||
    parsed.reconciliationStatus === "RECONCILIATION_RPC_TIMEOUT";

  const noNewOutboundTransfer = inferNoNewOutboundTransfer({
    parsed,
    binding,
    paymentAttempted: execution.paymentAttempted,
    quoteAtomic: selected.quote_atomic,
  });

  const classification = classifyX402Settlement({
    probe: {
      paymentAttempted: execution.paymentAttempted,
      paymentBearingHttpRequestCount: execution.paymentBearingHttpRequestCount,
      httpStatus: execution.httpStatus,
      balanceBeforeUsdc: execution.balanceBeforeUsdc,
      onChainConfirmed: bindingConfirmed && parsed.safeToUseForPaymentVerification,
      facilitatorReceiptParseStatus:
        (receiptArtifact?.parse_status as "parsed" | "missing" | "malformed" | undefined) ??
        (execution.facilitatorReceiptParseStatus as "parsed" | "missing" | "malformed" | undefined) ??
        null,
      facilitatorReceiptPresent: Boolean(receiptArtifact?.transaction_hash || execution.facilitatorTransactionHash),
    },
    reconciliationUnavailable: rpcUnavailable,
    reconciliationStatus: reconcileTimedOut ? "RECONCILIATION_RPC_TIMEOUT" : parsed.reconciliationStatus,
    safeToUseForPaymentVerification: parsed.safeToUseForPaymentVerification,
    unattributedSettlementsFound: parsed.unattributedSettlementsFound,
    balanceIdentityStatus: parsed.balanceIdentityStatus,
    noNewOutboundTransfer,
    binding,
    bindingMetrics: bindingResult?.metrics ?? null,
  });

  const classificationFile =
    profile.id === "sepolia" ? "sepolia_classification.json" : "x402_classification.json";
  await writeFile(
    join(runDir, classificationFile),
    `${JSON.stringify(classification, null, 2)}\n`,
    "utf8",
  );

  const metrics = bindingResult?.metrics;
  const proven = classification.outcome === "PASS_SETTLED";
  const cleanNoSettle = classification.outcome === "PASS_NO_SETTLE_CLEAN";

  const resultBanner = proven
    ? profile.id === "sepolia"
      ? "SEPOLIA_SETTLEMENT_PROVEN"
      : "MAINNET_THIN_SETTLEMENT_PROVEN"
    : classification.outcome === "RECONCILIATION_RPC_TIMEOUT"
      ? "PHASE62B_RECONCILIATION_RPC_TIMEOUT"
      : cleanNoSettle
        ? "PASS_NO_SETTLE_CLEAN"
        : `x402_classification_status: ${classification.outcome}`;

  const lines = [
    "RESULT",
    resultBanner,
    `network_profile: ${profile.id}`,
    `run_dir: ${runDir}`,
    `current_attempt_id: ${intent?.attempt_id ?? "null"}`,
    `paid_probe_outcome: ${classification.outcome}`,
    `settlement_tx_hash: ${classification.settlementTxHash ?? "null"}`,
    `reconciliation_status: ${classification.reconciliationStatus ?? "null"}`,
    `facilitator_receipt_parse_status: ${receiptArtifact?.parse_status ?? "not_found"}`,
    `binding_status: ${binding?.settlement_status ?? "not_run"}`,
    `facilitator_hash_agrees: ${binding?.facilitator_hash_agrees ?? "null"}`,
    `known_settlements_confirmed_onchain: ${metrics?.known_settlements_confirmed_onchain ?? "null"}`,
    `phase6_settlements_identified: ${metrics?.phase6_settlements_identified ?? "null"}`,
    `unattributed_settlements_found: ${metrics?.unattributed_settlements_found ?? "null"}`,
    `balance_identity_status: ${classification.balanceIdentityStatus ?? "null"}`,
    `safe_to_use_for_payment_verification: ${classification.safeToUseForPaymentVerification ? "yes" : "no"}`,
    "agent_signed: no",
    `strict_no_mainnet: ${profile.id === "mainnet" ? "n/a_mainnet_intended" : "yes"}`,
    `detail: ${classification.detail}`,
    "NEXT",
    proven
      ? "Settlement proof complete via thin runner."
      : cleanNoSettle
        ? "Valid no-settle outcome; do not retry without new authorization."
        : classification.outcome === "RECONCILIATION_RPC_TIMEOUT"
          ? "Retry classify only with keyed RPC; do not re-pay."
          : "Resolve blocker; do not retry-grind.",
  ];
  await writeFile(join(runDir, "RESULT.txt"), `${lines.join("\n")}\n`, "utf8");

  const exitCode =
    proven || cleanNoSettle || classification.outcome === "SETTLED_ONCHAIN_FACILITATOR_HASH_MISSING"
      ? 0
      : 1;
  return { exitCode, lines };
}
