/**
 * authority-policy-evaluator — read-only autonomy evaluation (B.6.3).
 * evaluate(intent, authorityView) only. Never creates/mutates authority.
 * AUTONOMY_ALLOWED != SEND.
 */

import {
  AUTHORITY_NOT_PREEXISTING,
  AUTONOMY_DENIED_AGGREGATE_LIMIT,
  AUTONOMY_DENIED_ASSET_SCOPE,
  AUTONOMY_DENIED_AUTHORITY_EXPIRED,
  AUTONOMY_DENIED_AUTHORITY_NOT_YET_VALID,
  AUTONOMY_DENIED_AUTHORITY_REVOKED,
  AUTONOMY_DENIED_CAPABILITY_SCOPE,
  AUTONOMY_DENIED_INVALID_AUTHORITY_SIGNATURE,
  AUTONOMY_DENIED_NEED_AUTHORITY_CLASS,
  AUTONOMY_DENIED_NETWORK_SCOPE,
  AUTONOMY_DENIED_PER_TRANSACTION_LIMIT,
  AUTONOMY_DENIED_PROVIDER_SCOPE,
  AUTONOMY_DENIED_RECENT_AMBIGUOUS_SEND,
  AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT,
  AUTONOMY_DENIED_SELLER_IDENTITY_CHANGE,
  AUTONOMY_DENIED_SELLER_SCOPE,
  AUTONOMY_DENIED_TRANSACTION_COUNT_LIMIT,
  AUTONOMY_DENIED_UNSIGNED_AUTHORITY,
  AUTONOMY_DENIED_WINDOW_SPEND_LIMIT,
  AUTONOMY_DENIED_WINDOW_TX_COUNT_LIMIT,
  GUARD_AUTHORITY_CURRENT_REVOCATION_STATE,
  GUARD_AUTONOMY_AUTHORITY_CAPABILITY_SCOPE,
  GUARD_AUTONOMY_AUTHORITY_SIGNATURE_VALID,
  GUARD_B63_CANNOT_CREATE_OR_MUTATE_AUTONOMY_AUTHORITY,
  assertB63HasNoExecutionAuthority,
  type AutonomyOutcome,
} from "./b63-execution-gates";
import { verifyAutonomyAuthorityTestSignature } from "./authority-signature-verify";
import {
  deriveAvailableBudget,
} from "./authority-consumption-ledger";
import {
  isAuthorityRevoked,
  type AuthorityRevocationLedger,
} from "./authority-revocation-ledger";
import type { AuthorityView } from "./authority-view";
import {
  LIVE_PRICE_MOVEMENT_OBSERVED,
  QUOTE_IDENTITY_CONTRADICTION,
  classifyHistoricalVsLiveQuote,
  classifyIntraObservationContradiction,
} from "./quote-observation-semantics";
import type { PaymentApprovalIntent } from "./payment-approval-intent";
import { paymentApprovalIntentHash } from "./payment-approval-intent";
import type { PaymentDecisionObjectiveV1 } from "./payment-decision-objective-v1";
import type { PaymentNeedV1 } from "./payment-need-v1";
import type { PaymentSelectionDecisionV1 } from "./payment-selection-decision-v1";
import {
  buildPaymentAuthorityDecision,
  type PaymentAuthorityDecisionV1,
} from "./payment-authority-decision-v1";
import type { AutonomyAuthorityV1 } from "./autonomy-authority-v1";
import { assertAutonomyAuthorityIntegrity } from "./autonomy-authority-v1";

export interface LiveEconomicsInput {
  readonly amountAtomic: string;
  readonly asset: string;
  readonly network: string;
  readonly payTo: string;
  readonly provider: string;
  readonly requirementsHash: string | null;
  readonly observedAt: string;
  /** Optional historical/census amount for movement classification. */
  readonly historicalAmountAtomic?: string | null;
  /** Same live observation with a second incompatible amount → identity contradiction. */
  readonly contradictoryLiveAmountAtomic?: string | null;
}

export interface AuthorityEvaluateInput {
  readonly need: PaymentNeedV1;
  readonly objective: PaymentDecisionObjectiveV1;
  readonly selection: PaymentSelectionDecisionV1;
  readonly intent: PaymentApprovalIntent;
  readonly live: LiveEconomicsInput;
  readonly view: AuthorityView;
  readonly now?: Date;
  readonly signatureVerifier?: (authority: AutonomyAuthorityV1) => boolean;
}

/**
 * Read-only authority evaluation.
 * Must not import authority mutation / minting APIs except signature verify callback.
 */
export function evaluatePaymentAuthority(
  input: AuthorityEvaluateInput,
): PaymentAuthorityDecisionV1 {
  assertB63HasNoExecutionAuthority();
  void GUARD_B63_CANNOT_CREATE_OR_MUTATE_AUTONOMY_AUTHORITY;

  const now = input.now ?? new Date();
  const intentHash = paymentApprovalIntentHash(input.intent);
  const matched: string[] = [];
  const failed: string[] = [];
  const humanReasons: string[] = [];

  const denyLocal = (
    failedLocal: string[],
    extras?: Partial<PaymentAuthorityDecisionV1>,
  ): PaymentAuthorityDecisionV1 => {
    const ih = paymentApprovalIntentHash(input.intent);
    return buildPaymentAuthorityDecision({
      createdAt: now.toISOString(),
      authorityId: extras?.authorityId ?? input.view.getAuthority()?.authorityId ?? null,
      authorityHash: extras?.authorityHash ?? input.view.getAuthority()?.authorityHash ?? null,
      needId: input.need.needId,
      needHash: input.need.needHash,
      objectiveId: input.objective.objectiveId,
      objectiveHash: input.objective.objectiveHash,
      selectionDecisionId: input.selection.selectionDecisionId,
      selectionDecisionHash: input.selection.selectionDecisionHash,
      paymentApprovalIntentId: ih.slice(0, 32),
      paymentApprovalIntentHash: ih,
      liveRequirementsHash: input.live.requirementsHash,
      liveObservedAt: input.live.observedAt,
      liveAmountAtomic: input.live.amountAtomic,
      consumptionLedgerViewHash: input.view.getConsumptionEvents().ledgerHash,
      revocationLedgerViewHash: input.view.getRevocations().ledgerHash,
      sellerExecutionHistoryHash:
        extras?.sellerExecutionHistoryHash ??
        input.view.getSellerExecutionHistory(input.live.payTo)?.historyHash ??
        null,
      decision: "AUTONOMY_DENIED",
      matchedConstraints: extras?.matchedConstraints ?? [...matched],
      failedConstraints: failedLocal,
      humanRequiredReasons: [],
      availableBudgetBefore: extras?.availableBudgetBefore ?? null,
      proposedAmount: input.live.amountAtomic,
      availableBudgetAfterIfExecuted: null,
    });
  };

  // Upstream binding
  if (input.objective.needHash && input.objective.needHash !== input.need.needHash) {
    failed.push("needHash_mismatch");
    return denyLocal(failed);
  }
  if (input.selection.objectiveHash !== input.objective.objectiveHash) {
    failed.push("objectiveHash_mismatch");
    return denyLocal(failed);
  }
  if (input.intent.selection_decision_hash !== input.selection.selectionDecisionHash) {
    failed.push("selectionDecisionHash_mismatch");
    return denyLocal(failed);
  }
  if (
    input.intent.objective_hash !== undefined &&
    input.intent.objective_hash !== input.objective.objectiveHash
  ) {
    failed.push("intent_objectiveHash_mismatch");
    return denyLocal(failed);
  }
  if (
    input.intent.need_hash !== undefined &&
    input.intent.need_hash !== input.need.needHash
  ) {
    failed.push("intent_needHash_mismatch");
    return denyLocal(failed);
  }
  if (input.selection.decision !== "BUY") {
    failed.push("selection_not_BUY");
    return denyLocal(failed);
  }
  matched.push("upstream_chain_bound");

  // Live identity contradiction (A.2)
  if (input.live.contradictoryLiveAmountAtomic) {
    const c = classifyIntraObservationContradiction({
      amount_a: input.live.amountAtomic,
      amount_b: input.live.contradictoryLiveAmountAtomic,
      same_observation: true,
    });
    if (c.fail_closed) {
      failed.push(QUOTE_IDENTITY_CONTRADICTION);
      return denyLocal(failed);
    }
  }

  // Live price movement observation (informational — live economics still authoritative)
  if (
    input.live.historicalAmountAtomic &&
    input.live.historicalAmountAtomic !== input.live.amountAtomic
  ) {
    const move = classifyHistoricalVsLiveQuote({
      historical: { amount_atomic: input.live.historicalAmountAtomic },
      live: { amount_atomic: input.live.amountAtomic },
    });
    if (move.classification === QUOTE_IDENTITY_CONTRADICTION) {
      failed.push(QUOTE_IDENTITY_CONTRADICTION);
      return denyLocal(failed);
    }
    matched.push(LIVE_PRICE_MOVEMENT_OBSERVED);
  }

  const authority = input.view.getAuthority();
  if (!authority) {
    return buildPaymentAuthorityDecision({
      createdAt: now.toISOString(),
      authorityId: null,
      authorityHash: null,
      needId: input.need.needId,
      needHash: input.need.needHash,
      objectiveId: input.objective.objectiveId,
      objectiveHash: input.objective.objectiveHash,
      selectionDecisionId: input.selection.selectionDecisionId,
      selectionDecisionHash: input.selection.selectionDecisionHash,
      paymentApprovalIntentId: intentHash.slice(0, 32),
      paymentApprovalIntentHash: intentHash,
      liveRequirementsHash: input.live.requirementsHash,
      liveObservedAt: input.live.observedAt,
      liveAmountAtomic: input.live.amountAtomic,
      consumptionLedgerViewHash: input.view.getConsumptionEvents().ledgerHash,
      revocationLedgerViewHash: input.view.getRevocations().ledgerHash,
      sellerExecutionHistoryHash: null,
      decision: "AUTHORITY_UNAVAILABLE",
      matchedConstraints: matched,
      failedConstraints: ["NO_PREEXISTING_AUTONOMY_AUTHORITY"],
      humanRequiredReasons: [],
      availableBudgetBefore: null,
      proposedAmount: input.live.amountAtomic,
      availableBudgetAfterIfExecuted: null,
    });
  }

  assertAutonomyAuthorityIntegrity(authority);

  // Preexistence
  if (Date.parse(authority.createdAt) >= Date.parse(input.need.createdAt)) {
    failed.push(AUTHORITY_NOT_PREEXISTING);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("authority_preexists_need");

  // Signature
  void GUARD_AUTONOMY_AUTHORITY_SIGNATURE_VALID;
  if (!authority.issuerSignature) {
    failed.push(AUTONOMY_DENIED_UNSIGNED_AUTHORITY);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  const verify =
    input.signatureVerifier ?? verifyAutonomyAuthorityTestSignature;
  if (!verify(authority)) {
    failed.push(AUTONOMY_DENIED_INVALID_AUTHORITY_SIGNATURE);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("authority_signature_valid");

  // Temporal
  const t = now.getTime();
  if (t < Date.parse(authority.validFrom)) {
    failed.push(AUTONOMY_DENIED_AUTHORITY_NOT_YET_VALID);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  if (t >= Date.parse(authority.validUntil)) {
    failed.push(AUTONOMY_DENIED_AUTHORITY_EXPIRED);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("authority_temporally_valid");

  // Revocation current view
  void GUARD_AUTHORITY_CURRENT_REVOCATION_STATE;
  const revocations = input.view.getRevocations();
  if (isAuthorityRevoked(revocations, authority.authorityId)) {
    failed.push(AUTONOMY_DENIED_AUTHORITY_REVOKED);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("authority_not_revoked");

  // Need authority class
  if (
    !authority.allowedNeedAuthorityClasses.includes(input.need.needAuthorityClass)
  ) {
    failed.push(AUTONOMY_DENIED_NEED_AUTHORITY_CLASS);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("need_authority_class");

  // Capability
  void GUARD_AUTONOMY_AUTHORITY_CAPABILITY_SCOPE;
  if (!authority.allowedCapabilities.includes(input.objective.requestedCapability)) {
    failed.push(AUTONOMY_DENIED_CAPABILITY_SCOPE);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("capability_scope");

  // Provider / seller
  if (
    authority.allowedProviders.length > 0 &&
    !authority.allowedProviders.includes(input.live.provider) &&
    !authority.allowedProviders.includes(input.intent.provider)
  ) {
    failed.push(AUTONOMY_DENIED_PROVIDER_SCOPE);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("provider_scope");

  const seller = input.live.payTo.toLowerCase();
  if (
    authority.allowedSellers.length > 0 &&
    !authority.allowedSellers.map((s) => s.toLowerCase()).includes(seller)
  ) {
    failed.push(AUTONOMY_DENIED_SELLER_SCOPE);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("seller_scope");

  // Network / asset
  if (!authority.allowedNetworks.includes(input.live.network)) {
    failed.push(AUTONOMY_DENIED_NETWORK_SCOPE);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("network_scope");

  const assetOk =
    authority.allowedAssets.includes(input.live.asset) ||
    authority.allowedAssets
      .map((a) => a.toLowerCase())
      .includes(input.live.asset.toLowerCase()) ||
    authority.allowedAssets.includes(input.intent.asset_symbol) ||
    authority.allowedAssets
      .map((a) => a.toLowerCase())
      .includes(input.intent.asset.toLowerCase());
  if (!assetOk) {
    failed.push(AUTONOMY_DENIED_ASSET_SCOPE);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
    });
  }
  matched.push("asset_scope");

  // Budget derivation
  const consumption = input.view.getConsumptionEvents();
  const budget = deriveAvailableBudget({
    ledger: consumption,
    maxAggregateSpend: authority.maxAggregateSpend,
    accountingWindowMs: authority.accountingWindowMs,
    now,
  });

  const proposed = BigInt(input.live.amountAtomic);

  // Per-tx (LIVE economics)
  if (proposed > BigInt(authority.maxPerTransaction)) {
    failed.push(AUTONOMY_DENIED_PER_TRANSACTION_LIMIT);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
      availableBudgetBefore: budget.availableAggregate,
    });
  }
  matched.push("per_transaction_limit");

  // Aggregate
  if (proposed > BigInt(budget.availableAggregate)) {
    failed.push(AUTONOMY_DENIED_AGGREGATE_LIMIT);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
      availableBudgetBefore: budget.availableAggregate,
    });
  }
  matched.push("aggregate_limit");

  // Tx count
  if (budget.transactionCountCharged + 1 > authority.maxTransactionCount) {
    failed.push(AUTONOMY_DENIED_TRANSACTION_COUNT_LIMIT);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
      availableBudgetBefore: budget.availableAggregate,
    });
  }
  matched.push("transaction_count_limit");

  // Window
  if (
    BigInt(budget.windowSpendCharged) + proposed >
    BigInt(authority.maxSpendPerWindow)
  ) {
    failed.push(AUTONOMY_DENIED_WINDOW_SPEND_LIMIT);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
      availableBudgetBefore: budget.availableAggregate,
    });
  }
  matched.push("window_spend_limit");

  if (budget.windowTxCharged + 1 > authority.maxTransactionsPerWindow) {
    failed.push(AUTONOMY_DENIED_WINDOW_TX_COUNT_LIMIT);
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
      availableBudgetBefore: budget.availableAggregate,
    });
  }
  matched.push("window_tx_count_limit");

  // Seller history
  const history = input.view.getSellerExecutionHistory(seller);
  const req = authority.sellerHistoryRequirements;
  let sellerHistoryHash: string | null = history?.historyHash ?? null;

  if (!history) {
    if (req.minimumSuccessfulSettlements > 0) {
      if (authority.humanRequired.insufficientSellerHistory) {
        humanReasons.push(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
      } else {
        failed.push(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
        return denyLocal(failed, {
          authorityId: authority.authorityId,
          authorityHash: authority.authorityHash,
          availableBudgetBefore: budget.availableAggregate,
        });
      }
    }
  } else {
    if (history.successfulSettlements < req.minimumSuccessfulSettlements) {
      if (authority.humanRequired.insufficientSellerHistory) {
        humanReasons.push(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
      } else {
        failed.push(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
        return denyLocal(failed, {
          authorityId: authority.authorityId,
          authorityHash: authority.authorityHash,
          sellerExecutionHistoryHash: sellerHistoryHash,
          availableBudgetBefore: budget.availableAggregate,
        });
      }
    }
    if (history.distinctSuccessfulDays < req.minimumDistinctSuccessfulDays) {
      if (authority.humanRequired.insufficientSellerHistory) {
        humanReasons.push(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
      } else {
        failed.push(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
        return denyLocal(failed, {
          authorityId: authority.authorityId,
          authorityHash: authority.authorityHash,
          sellerExecutionHistoryHash: sellerHistoryHash,
          availableBudgetBefore: budget.availableAggregate,
        });
      }
    }
    if (history.unresolvedIdentityChanges > req.maximumUnresolvedIdentityChanges) {
      failed.push(AUTONOMY_DENIED_SELLER_IDENTITY_CHANGE);
      return denyLocal(failed, {
        authorityId: authority.authorityId,
        authorityHash: authority.authorityHash,
        sellerExecutionHistoryHash: sellerHistoryHash,
        availableBudgetBefore: budget.availableAggregate,
      });
    }
    if (history.ambiguousSendEvents > req.maximumRecentAmbiguousSendCount) {
      failed.push(AUTONOMY_DENIED_RECENT_AMBIGUOUS_SEND);
      return denyLocal(failed, {
        authorityId: authority.authorityId,
        authorityHash: authority.authorityHash,
        sellerExecutionHistoryHash: sellerHistoryHash,
        availableBudgetBefore: budget.availableAggregate,
      });
    }
    if (
      req.requireDeliveredUtilityEvidence &&
      history.deliveredUtilityObservations < 1
    ) {
      if (authority.humanRequired.insufficientSellerHistory) {
        humanReasons.push("delivered_utility_evidence_missing");
      } else {
        failed.push(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
        return denyLocal(failed, {
          authorityId: authority.authorityId,
          authorityHash: authority.authorityHash,
          sellerExecutionHistoryHash: sellerHistoryHash,
          availableBudgetBefore: budget.availableAggregate,
        });
      }
    }
    if (failed.length === 0 && humanReasons.length === 0) {
      matched.push("seller_history_sufficient");
    }
  }

  // Explicit human-required rules
  if (
    authority.humanRequired.firstSellerExecution &&
    (!history || history.successfulSettlements === 0)
  ) {
    humanReasons.push("first_seller_execution");
  }
  if (
    authority.humanRequired.capabilityClasses.includes(
      input.objective.requestedCapability,
    )
  ) {
    humanReasons.push("capability_class_requires_human");
  }
  if (
    authority.humanRequired.amountAboveAtomic &&
    proposed > BigInt(authority.humanRequired.amountAboveAtomic)
  ) {
    humanReasons.push("amount_above_human_threshold");
  }

  const availableAfter = (
    BigInt(budget.availableAggregate) - proposed
  ).toString();

  if (failed.length > 0) {
    return denyLocal(failed, {
      authorityId: authority.authorityId,
      authorityHash: authority.authorityHash,
      sellerExecutionHistoryHash: sellerHistoryHash,
      availableBudgetBefore: budget.availableAggregate,
      matchedConstraints: matched,
    });
  }

  let decision: AutonomyOutcome = "AUTONOMY_ALLOWED";
  if (humanReasons.length > 0) {
    decision = "HUMAN_REQUIRED";
  }

  return buildPaymentAuthorityDecision({
    createdAt: now.toISOString(),
    authorityId: authority.authorityId,
    authorityHash: authority.authorityHash,
    needId: input.need.needId,
    needHash: input.need.needHash,
    objectiveId: input.objective.objectiveId,
    objectiveHash: input.objective.objectiveHash,
    selectionDecisionId: input.selection.selectionDecisionId,
    selectionDecisionHash: input.selection.selectionDecisionHash,
    paymentApprovalIntentId: intentHash.slice(0, 32),
    paymentApprovalIntentHash: intentHash,
    liveRequirementsHash: input.live.requirementsHash,
    liveObservedAt: input.live.observedAt,
    liveAmountAtomic: input.live.amountAtomic,
    consumptionLedgerViewHash: consumption.ledgerHash,
    revocationLedgerViewHash: revocations.ledgerHash,
    sellerExecutionHistoryHash: sellerHistoryHash,
    decision,
    matchedConstraints: matched,
    failedConstraints: [],
    humanRequiredReasons: humanReasons,
    availableBudgetBefore: budget.availableAggregate,
    proposedAmount: input.live.amountAtomic,
    availableBudgetAfterIfExecuted: availableAfter,
  });
}

/**
 * Pre-JIT recheck: authority + revocation must still pass.
 * Synthetic/test only — no signer.
 */
export function recheckAuthorityBeforeJit(input: {
  readonly authority: AutonomyAuthorityV1;
  readonly revocations: AuthorityRevocationLedger;
  readonly now: Date;
}): { readonly ok: true } | { readonly ok: false; readonly code: string } {
  void GUARD_AUTHORITY_CURRENT_REVOCATION_STATE;
  if (isAuthorityRevoked(input.revocations, input.authority.authorityId)) {
    return { ok: false, code: AUTONOMY_DENIED_AUTHORITY_REVOKED };
  }
  const t = input.now.getTime();
  if (t >= Date.parse(input.authority.validUntil)) {
    return { ok: false, code: AUTONOMY_DENIED_AUTHORITY_EXPIRED };
  }
  if (t < Date.parse(input.authority.validFrom)) {
    return { ok: false, code: AUTONOMY_DENIED_AUTHORITY_NOT_YET_VALID };
  }
  return { ok: true };
}

