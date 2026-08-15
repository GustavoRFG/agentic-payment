/**
 * B.6.3 pre-existing bounded payment authority — headless tests.
 * NO REAL PAYMENT. NO UI. NO DPAPI. NO SIGNER. NO REAL AUTONOMY AUTHORITY.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

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
  AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION,
  B63_PREEXISTING_BOUNDED_PAYMENT_AUTHORITY_READY_NO_PAYMENT,
  GUARD_B63_CANNOT_CREATE_OR_MUTATE_AUTONOMY_AUTHORITY,
  assertB63HasNoExecutionAuthority,
} from "../../tools/trustforge/b63-execution-gates";
import {
  evaluatePaymentAuthority,
  recheckAuthorityBeforeJit,
} from "../../tools/trustforge/authority-policy-evaluator";
import { mintTestAutonomyAuthority } from "../../tools/trustforge/authority-test-issuer";
import {
  appendConsumptionEvent,
  assertConsumptionLedgerIntegrity,
  buildEmptyConsumptionLedger,
  deriveAvailableBudget,
} from "../../tools/trustforge/authority-consumption-ledger";
import {
  appendRevocationEvent,
  buildEmptyRevocationLedger,
} from "../../tools/trustforge/authority-revocation-ledger";
import {
  AUTHORITY_VIEW_FORBIDDEN_METHODS,
  createReadonlyAuthorityView,
} from "../../tools/trustforge/authority-view";
import {
  assertAtomicReservationRequiredBeforeAutonomousSend,
  buildAuthoritySpendReservation,
  PRE_JIT_AUTHORITY_REVALIDATION_CONTRACT,
} from "../../tools/trustforge/authority-spend-reservation";
import { buildSellerExecutionHistory } from "../../tools/trustforge/seller-execution-history-v1";
import { runB61DecisionFromCandidates } from "../../tools/trustforge/b61-run-decision";
import { deriveObjectiveFromEstablishedNeed } from "../../tools/trustforge/derive-objective-from-need";
import { assessEconomicV2 } from "../../tools/trustforge/economic-assessment-v2";
import {
  assertPaymentApprovalIntentBindsSelectionDecision,
  buildPaymentApprovalIntentFromSelected,
  paymentApprovalIntentHash,
} from "../../tools/trustforge/payment-approval-intent";
import { normalizeRawPaymentCandidateObservation } from "../../tools/trustforge/payment-candidate-normalize";
import type { CandidatePolicyVerdict } from "../../tools/trustforge/payment-candidate-policy";
import type { PaymentCandidateV1 } from "../../tools/trustforge/payment-candidate-v1";
import { buildHumanCryptoNewsNeed } from "../../tools/trustforge/payment-need-builders";
import { assessNeedProvenance } from "../../tools/trustforge/need-provenance-assessment-v1";
import { assertAuthorityDecisionBindsIntent } from "../../tools/trustforge/payment-authority-decision-v1";
import { LIVE_PRICE_MOVEMENT_OBSERVED, QUOTE_IDENTITY_CONTRADICTION } from "../../tools/trustforge/quote-observation-semantics";
import {
  SYNTHETIC_PAY_TO_B,
  syntheticObservation,
} from "../support/trustforge-b5-synthetic-candidates";

const NOW = new Date("2026-08-15T12:00:00.000Z");
const NEED_AT = "2026-08-15T11:00:00.000Z";
const AUTH_AT = "2026-08-15T10:00:00.000Z"; // before need
const OTTO = "https://x402.ottoai.services/crypto-news";
const SELLER = "0x0e84ddedaae6a779c462c22a59f301ec31b6b808";

function verdictFor(c: PaymentCandidateV1): CandidatePolicyVerdict {
  return {
    schema_version: "trustforge_candidate_policy_verdict.v1",
    candidate_id: c.candidate_id,
    observation_id: c.observation_id,
    candidate_sha256: "synthetic",
    verdict: "ELIGIBLE",
    reasons: [],
    payment_authorized: false,
    policy_sha256: "synthetic_policy",
    evaluated_at: NOW.toISOString(),
  };
}

function makeOtto(amount = "1000") {
  const syn = syntheticObservation({
    endpoint: OTTO,
    service_id: "ottoai_crypto_news",
    amount_atomic: amount,
    pay_to: SYNTHETIC_PAY_TO_B,
    purpose: "crypto_news",
    provider_id: "ottoai",
    discovered_at: "2026-08-15T11:55:00.000Z",
    with_execution_handoff: true,
  });
  const base = normalizeRawPaymentCandidateObservation(syn.raw);
  const candidate: PaymentCandidateV1 = {
    ...base,
    expected_utility: {
      purpose: "crypto_news",
      utility_confidence: "medium",
      evidence: "prior_delivered_crypto_news_market_brief",
    },
  };
  expect(syn.selected).not.toBeNull();
  return { candidate, selected: syn.selected! };
}

function buildChain(opts?: { readonly amount?: string }) {
  const need = buildHumanCryptoNewsNeed({ createdAt: NEED_AT });
  const provenance = assessNeedProvenance(need);
  const { objective } = deriveObjectiveFromEstablishedNeed({
    need,
    provenance,
    now: NOW,
  });
  const otto = makeOtto(opts?.amount ?? "1000");
  const rows = [
    {
      candidate: otto.candidate,
      verdict: verdictFor(otto.candidate),
      economicsV2: assessEconomicV2(otto.candidate, verdictFor(otto.candidate), {
        now: NOW,
        priorDeliveredUtilityEvidence: true,
        utilityConfidenceOverride: "medium",
      }),
    },
  ];
  const { decision: selection } = runB61DecisionFromCandidates(rows, objective, {
    now: NOW,
  });
  expect(selection.decision).toBe("BUY");
  const intent = buildPaymentApprovalIntentFromSelected({
    selected: otto.selected,
    selectionDecisionHash: selection.selectionDecisionHash,
    selectedCandidateId: selection.selectedCandidateId ?? undefined,
    selectedObservationId: selection.selectedObservationId ?? undefined,
    candidateSetHash: selection.candidateSetHash,
    objectiveId: objective.objectiveId,
    objectiveHash: objective.objectiveHash,
    needId: need.needId,
    needHash: need.needHash,
  });
  assertPaymentApprovalIntentBindsSelectionDecision(intent, selection);
  return { need, objective, selection, intent, otto };
}

function goodHistory() {
  return buildSellerExecutionHistory({
    seller: SELLER,
    provider: "ottoai",
    successfulSettlements: 3,
    distinctSuccessfulDays: 2,
    failedPaytimeAttempts: 0,
    ambiguousSendEvents: 0,
    requirementInstabilityEvents: 0,
    sellerIdentityChangeEvents: 0,
    unresolvedIdentityChanges: 0,
    deliveredUtilityObservations: 2,
    lastSuccessfulAt: "2026-08-14T12:00:00.000Z",
    historyAsOf: NOW.toISOString(),
  });
}

function goodAuthority(
  overrides: {
    readonly authorityId: string;
    readonly createdAt: string;
    readonly validFrom: string;
    readonly validUntil: string;
  } & Record<string, unknown>,
) {
  return mintTestAutonomyAuthority(
    overrides as Parameters<typeof mintTestAutonomyAuthority>[0],
  );
}

describe("B.6.3 authority outcomes", () => {
  it("AUTHORITY_UNAVAILABLE when no authority despite perfect chain", () => {
    const chain = buildChain();
    const view = createReadonlyAuthorityView({
      authority: null,
      revocations: buildEmptyRevocationLedger(),
      consumption: buildEmptyConsumptionLedger("none"),
      sellerHistories: new Map([[SELLER, goodHistory()]]),
    });
    const d = evaluatePaymentAuthority({
      ...chain,
      live: {
        amountAtomic: "1000",
        asset: "USDC",
        network: "eip155:8453",
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: "req",
        observedAt: NOW.toISOString(),
      },
      view,
      now: NOW,
    });
    expect(d.decision).toBe("AUTHORITY_UNAVAILABLE");
    expect(d.payment_authorized).toBe(false);
    expect(d.send_authorized).toBe(false);
  });

  it("AUTONOMY_ALLOWED for valid pre-existing signed authority", () => {
    const chain = buildChain();
    const authority = goodAuthority({
      authorityId: "auth_ok",
      createdAt: AUTH_AT,
      validFrom: AUTH_AT,
      validUntil: "2026-12-31T00:00:00.000Z",
      allowedProviders: ["ottoai", "bazaar_unpaid"],
    });
    const view = createReadonlyAuthorityView({
      authority,
      revocations: buildEmptyRevocationLedger(),
      consumption: buildEmptyConsumptionLedger(authority.authorityId),
      sellerHistories: new Map([[SELLER, goodHistory()]]),
    });
    const d = evaluatePaymentAuthority({
      ...chain,
      live: {
        amountAtomic: "1000",
        asset: "USDC",
        network: "eip155:8453",
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: "req",
        observedAt: NOW.toISOString(),
      },
      view,
      now: NOW,
    });
    expect(d.decision).toBe("AUTONOMY_ALLOWED");
    assertAuthorityDecisionBindsIntent({
      decision: d,
      paymentApprovalIntentHash: paymentApprovalIntentHash(chain.intent),
    });
  });

  it("HUMAN_REQUIRED when policy requires human for capability class", () => {
    const chain = buildChain();
    const authority = goodAuthority({
      authorityId: "auth_human",
      createdAt: AUTH_AT,
      validFrom: AUTH_AT,
      validUntil: "2026-12-31T00:00:00.000Z",
      allowedProviders: ["ottoai", "bazaar_unpaid"],
      humanRequired: {
        firstSellerExecution: false,
        capabilityClasses: ["crypto_news"],
        amountAboveAtomic: null,
        insufficientSellerHistory: false,
      },
    });
    const view = createReadonlyAuthorityView({
      authority,
      revocations: buildEmptyRevocationLedger(),
      consumption: buildEmptyConsumptionLedger(authority.authorityId),
      sellerHistories: new Map([[SELLER, goodHistory()]]),
    });
    const d = evaluatePaymentAuthority({
      ...chain,
      live: {
        amountAtomic: "1000",
        asset: "USDC",
        network: "eip155:8453",
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: "req",
        observedAt: NOW.toISOString(),
      },
      view,
      now: NOW,
    });
    expect(d.decision).toBe("HUMAN_REQUIRED");
  });
});

describe("B.6.3 negative matrix", () => {
  it("authority created after need → AUTHORITY_NOT_PREEXISTING", () => {
    const chain = buildChain();
    const authority = goodAuthority({
      authorityId: "auth_late",
      createdAt: "2026-08-15T11:30:00.000Z", // after NEED_AT
      validFrom: "2026-08-15T11:30:00.000Z",
      validUntil: "2026-12-31T00:00:00.000Z",
      allowedProviders: ["ottoai", "bazaar_unpaid"],
    });
    const view = createReadonlyAuthorityView({
      authority,
      revocations: buildEmptyRevocationLedger(),
      consumption: buildEmptyConsumptionLedger(authority.authorityId),
      sellerHistories: new Map([[SELLER, goodHistory()]]),
    });
    const d = evaluatePaymentAuthority({
      ...chain,
      live: {
        amountAtomic: "1000",
        asset: "USDC",
        network: "eip155:8453",
        payTo: SELLER,
        provider: "ottoai",
        requirementsHash: "req",
        observedAt: NOW.toISOString(),
      },
      view,
      now: NOW,
    });
    expect(d.decision).toBe("AUTONOMY_DENIED");
    expect(d.failedConstraints).toContain(AUTHORITY_NOT_PREEXISTING);
  });

  it("unsigned / bad signature → DENIED", () => {
    const chain = buildChain();
    const signed = goodAuthority({
      authorityId: "auth_sig",
      createdAt: AUTH_AT,
      validFrom: AUTH_AT,
      validUntil: "2026-12-31T00:00:00.000Z",
      allowedProviders: ["ottoai", "bazaar_unpaid"],
    });
    const unsigned = { ...signed, issuerSignature: null };
    const bad = { ...signed, issuerSignature: "hmac-sha256:deadbeef" };
    for (const [auth, code] of [
      [unsigned, AUTONOMY_DENIED_UNSIGNED_AUTHORITY],
      [bad, AUTONOMY_DENIED_INVALID_AUTHORITY_SIGNATURE],
    ] as const) {
      const view = createReadonlyAuthorityView({
        authority: auth,
        revocations: buildEmptyRevocationLedger(),
        consumption: buildEmptyConsumptionLedger(auth.authorityId),
        sellerHistories: new Map([[SELLER, goodHistory()]]),
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view,
        now: NOW,
      });
      expect(d.failedConstraints).toContain(code);
    }
  });

  it("expired / revoked / wrong capability / per-tx / aggregate / seller history", () => {
    const chain = buildChain();
    const baseAuth = {
      createdAt: AUTH_AT,
      validFrom: AUTH_AT,
      allowedProviders: ["ottoai", "bazaar_unpaid"] as string[],
    };

    // expired
    {
      const authority = goodAuthority({
        ...baseAuth,
        authorityId: "auth_exp",
        validUntil: "2026-08-15T11:00:00.000Z",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_AUTHORITY_EXPIRED);
    }

    // revoked
    {
      const authority = goodAuthority({
        ...baseAuth,
        authorityId: "auth_rev",
        validUntil: "2026-12-31T00:00:00.000Z",
      });
      let rev = buildEmptyRevocationLedger();
      rev = appendRevocationEvent(rev, {
        eventId: "rev1",
        authorityId: authority.authorityId,
        revokedAt: NOW.toISOString(),
        reason: "human_revoke",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: rev,
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_AUTHORITY_REVOKED);
    }

    // wrong capability
    {
      const authority = goodAuthority({
        ...baseAuth,
        authorityId: "auth_cap",
        validUntil: "2026-12-31T00:00:00.000Z",
        allowedCapabilities: ["chain_block_number"],
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_CAPABILITY_SCOPE);
    }

    // live price jump vs ceiling
    {
      const authority = goodAuthority({
        ...baseAuth,
        authorityId: "auth_px",
        validUntil: "2026-12-31T00:00:00.000Z",
        maxPerTransaction: "1000",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "400000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
          historicalAmountAtomic: "1000",
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.matchedConstraints).toContain(LIVE_PRICE_MOVEMENT_OBSERVED);
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_PER_TRANSACTION_LIMIT);
      expect(d.decision).not.toBe("AUTONOMY_ALLOWED");
    }

    // identity contradiction
    {
      const authority = goodAuthority({
        ...baseAuth,
        authorityId: "auth_id",
        validUntil: "2026-12-31T00:00:00.000Z",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
          contradictoryLiveAmountAtomic: "400000",
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(QUOTE_IDENTITY_CONTRADICTION);
    }

    // single success seller history
    {
      const authority = goodAuthority({
        ...baseAuth,
        authorityId: "auth_hist",
        validUntil: "2026-12-31T00:00:00.000Z",
      });
      const hist = buildSellerExecutionHistory({
        seller: SELLER,
        provider: "ottoai",
        successfulSettlements: 1,
        distinctSuccessfulDays: 1,
        failedPaytimeAttempts: 0,
        ambiguousSendEvents: 0,
        requirementInstabilityEvents: 0,
        sellerIdentityChangeEvents: 0,
        unresolvedIdentityChanges: 0,
        deliveredUtilityObservations: 1,
        lastSuccessfulAt: NOW.toISOString(),
        historyAsOf: NOW.toISOString(),
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, hist]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_SELLER_HISTORY_INSUFFICIENT);
    }

    // ambiguous spend reserves budget
    {
      const authority = goodAuthority({
        ...baseAuth,
        authorityId: "auth_amb",
        validUntil: "2026-12-31T00:00:00.000Z",
        maxAggregateSpend: "1500",
      });
      let cons = buildEmptyConsumptionLedger(authority.authorityId);
      cons = appendConsumptionEvent(cons, {
        eventId: "amb1",
        kind: "CONSUMPTION_AMBIGUOUS",
        authorityId: authority.authorityId,
        amountAtomic: "1000",
        asset: "USDC",
        at: "2026-08-15T11:30:00.000Z",
        paymentApprovalIntentHash: "prior",
      });
      const budget = deriveAvailableBudget({
        ledger: cons,
        maxAggregateSpend: authority.maxAggregateSpend,
        accountingWindowMs: authority.accountingWindowMs,
        now: NOW,
      });
      expect(budget.reservedAmbiguous).toBe("1000");
      expect(BigInt(budget.availableAggregate)).toBe(500n);
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: cons,
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_AGGREGATE_LIMIT);
    }
  });

  it("revocation after decision blocks pre-JIT recheck", () => {
    const authority = goodAuthority({
      authorityId: "auth_jit",
      createdAt: AUTH_AT,
      validFrom: AUTH_AT,
      validUntil: "2026-12-31T00:00:00.000Z",
      allowedProviders: ["ottoai", "bazaar_unpaid"],
    });
    let rev = buildEmptyRevocationLedger();
    expect(recheckAuthorityBeforeJit({ authority, revocations: rev, now: NOW }).ok).toBe(
      true,
    );
    rev = appendRevocationEvent(rev, {
      eventId: "rev_late",
      authorityId: authority.authorityId,
      revokedAt: NOW.toISOString(),
      reason: "revoked_after_decision",
    });
    const r = recheckAuthorityBeforeJit({ authority, revocations: rev, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe(AUTONOMY_DENIED_AUTHORITY_REVOKED);
  });

  it("append-only ledger tamper detected", () => {
    let cons = buildEmptyConsumptionLedger("auth_t");
    cons = appendConsumptionEvent(cons, {
      eventId: "e1",
      kind: "CONSUMPTION_CONFIRMED",
      authorityId: "auth_t",
      amountAtomic: "1000",
      asset: "USDC",
      at: NOW.toISOString(),
      paymentApprovalIntentHash: "x",
    });
    assertConsumptionLedgerIntegrity(cons);
    const tampered = {
      ...cons,
      events: cons.events.map((e, i) =>
        i === 0 ? { ...e, amountAtomic: "1" } : e,
      ),
    };
    expect(() => assertConsumptionLedgerIntegrity(tampered)).toThrow();
  });

  it("not-yet-valid / provider / seller / network / asset / need-class", () => {
    const chain = buildChain();
    const base = {
      createdAt: AUTH_AT,
      allowedProviders: ["ottoai", "bazaar_unpaid"] as string[],
    };

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_nyv",
        validFrom: "2026-08-16T00:00:00.000Z",
        validUntil: "2026-12-31T00:00:00.000Z",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_AUTHORITY_NOT_YET_VALID);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_prov",
        validFrom: AUTH_AT,
        validUntil: "2026-12-31T00:00:00.000Z",
        allowedProviders: ["onesource"],
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_PROVIDER_SCOPE);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_seller",
        validFrom: AUTH_AT,
        validUntil: "2026-12-31T00:00:00.000Z",
        allowedSellers: ["0x1111111111111111111111111111111111111111"],
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_SELLER_SCOPE);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_net",
        validFrom: AUTH_AT,
        validUntil: "2026-12-31T00:00:00.000Z",
        allowedNetworks: ["eip155:1"],
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_NETWORK_SCOPE);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_asset",
        validFrom: AUTH_AT,
        validUntil: "2026-12-31T00:00:00.000Z",
        allowedAssets: ["ETH"],
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_ASSET_SCOPE);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_need_cls",
        validFrom: AUTH_AT,
        validUntil: "2026-12-31T00:00:00.000Z",
        allowedNeedAuthorityClasses: ["DERIVED_TASK_NEED"],
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_NEED_AUTHORITY_CLASS);
    }
  });

  it("tx-count / window spend / window tx / identity-change / ambiguous-send", () => {
    const chain = buildChain();
    const base = {
      createdAt: AUTH_AT,
      validFrom: AUTH_AT,
      validUntil: "2026-12-31T00:00:00.000Z",
      allowedProviders: ["ottoai", "bazaar_unpaid"] as string[],
    };

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_txc",
        maxTransactionCount: 1,
      });
      let cons = buildEmptyConsumptionLedger(authority.authorityId);
      cons = appendConsumptionEvent(cons, {
        eventId: "c1",
        kind: "CONSUMPTION_CONFIRMED",
        authorityId: authority.authorityId,
        amountAtomic: "100",
        asset: "USDC",
        at: "2026-08-15T11:00:00.000Z",
        paymentApprovalIntentHash: "prior",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: cons,
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_TRANSACTION_COUNT_LIMIT);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_wspend",
        maxSpendPerWindow: "500",
        maxAggregateSpend: "100000",
        maxPerTransaction: "1000",
      });
      let cons = buildEmptyConsumptionLedger(authority.authorityId);
      cons = appendConsumptionEvent(cons, {
        eventId: "w1",
        kind: "CONSUMPTION_CONFIRMED",
        authorityId: authority.authorityId,
        amountAtomic: "400",
        asset: "USDC",
        at: "2026-08-15T11:30:00.000Z",
        paymentApprovalIntentHash: "prior",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: cons,
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_WINDOW_SPEND_LIMIT);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_wtx",
        maxTransactionsPerWindow: 1,
      });
      let cons = buildEmptyConsumptionLedger(authority.authorityId);
      cons = appendConsumptionEvent(cons, {
        eventId: "wt1",
        kind: "CONSUMPTION_RESERVED",
        authorityId: authority.authorityId,
        amountAtomic: "100",
        asset: "USDC",
        at: "2026-08-15T11:30:00.000Z",
        paymentApprovalIntentHash: "prior",
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: cons,
          sellerHistories: new Map([[SELLER, goodHistory()]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_WINDOW_TX_COUNT_LIMIT);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_idchg",
      });
      const hist = buildSellerExecutionHistory({
        seller: SELLER,
        provider: "ottoai",
        successfulSettlements: 3,
        distinctSuccessfulDays: 2,
        failedPaytimeAttempts: 0,
        ambiguousSendEvents: 0,
        requirementInstabilityEvents: 0,
        sellerIdentityChangeEvents: 1,
        unresolvedIdentityChanges: 1,
        deliveredUtilityObservations: 2,
        lastSuccessfulAt: "2026-08-14T12:00:00.000Z",
        historyAsOf: NOW.toISOString(),
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, hist]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_SELLER_IDENTITY_CHANGE);
    }

    {
      const authority = goodAuthority({
        ...base,
        authorityId: "auth_ambsend",
      });
      const hist = buildSellerExecutionHistory({
        seller: SELLER,
        provider: "ottoai",
        successfulSettlements: 3,
        distinctSuccessfulDays: 2,
        failedPaytimeAttempts: 0,
        ambiguousSendEvents: 1,
        requirementInstabilityEvents: 0,
        sellerIdentityChangeEvents: 0,
        unresolvedIdentityChanges: 0,
        deliveredUtilityObservations: 2,
        lastSuccessfulAt: "2026-08-14T12:00:00.000Z",
        historyAsOf: NOW.toISOString(),
      });
      const d = evaluatePaymentAuthority({
        ...chain,
        live: {
          amountAtomic: "1000",
          asset: "USDC",
          network: "eip155:8453",
          payTo: SELLER,
          provider: "ottoai",
          requirementsHash: "req",
          observedAt: NOW.toISOString(),
        },
        view: createReadonlyAuthorityView({
          authority,
          revocations: buildEmptyRevocationLedger(),
          consumption: buildEmptyConsumptionLedger(authority.authorityId),
          sellerHistories: new Map([[SELLER, hist]]),
        }),
        now: NOW,
      });
      expect(d.failedConstraints).toContain(AUTONOMY_DENIED_RECENT_AMBIGUOUS_SEND);
    }
  });

  it("upstream hash mismatches fail closed", () => {
    const chain = buildChain();
    const authority = goodAuthority({
      authorityId: "auth_bind",
      createdAt: AUTH_AT,
      validFrom: AUTH_AT,
      validUntil: "2026-12-31T00:00:00.000Z",
      allowedProviders: ["ottoai", "bazaar_unpaid"],
    });
    const view = createReadonlyAuthorityView({
      authority,
      revocations: buildEmptyRevocationLedger(),
      consumption: buildEmptyConsumptionLedger(authority.authorityId),
      sellerHistories: new Map([[SELLER, goodHistory()]]),
    });
    const live = {
      amountAtomic: "1000",
      asset: "USDC",
      network: "eip155:8453",
      payTo: SELLER,
      provider: "ottoai",
      requirementsHash: "req",
      observedAt: NOW.toISOString(),
    };

    const needMismatch = evaluatePaymentAuthority({
      ...chain,
      objective: { ...chain.objective, needHash: "tampered_need" },
      live,
      view,
      now: NOW,
    });
    expect(needMismatch.failedConstraints).toContain("needHash_mismatch");

    const objMismatch = evaluatePaymentAuthority({
      ...chain,
      selection: { ...chain.selection, objectiveHash: "tampered_obj" },
      live,
      view,
      now: NOW,
    });
    expect(objMismatch.failedConstraints).toContain("objectiveHash_mismatch");

    const selMismatch = evaluatePaymentAuthority({
      ...chain,
      intent: { ...chain.intent, selection_decision_hash: "tampered_sel" },
      live,
      view,
      now: NOW,
    });
    expect(selMismatch.failedConstraints).toContain("selectionDecisionHash_mismatch");

    const intentMismatch = evaluatePaymentAuthority({
      ...chain,
      intent: { ...chain.intent, need_hash: "tampered_intent_need" },
      live,
      view,
      now: NOW,
    });
    expect(intentMismatch.failedConstraints).toContain("intent_needHash_mismatch");

    const ok = evaluatePaymentAuthority({ ...chain, live, view, now: NOW });
    expect(ok.decision).toBe("AUTONOMY_ALLOWED");
    assertAuthorityDecisionBindsIntent({
      decision: ok,
      paymentApprovalIntentHash: paymentApprovalIntentHash(chain.intent),
    });
    expect(() =>
      assertAuthorityDecisionBindsIntent({
        decision: ok,
        paymentApprovalIntentHash: paymentApprovalIntentHash({
          ...chain.intent,
          amount_atomic: "999",
        }),
      }),
    ).toThrow();
  });
});

describe("B.6.3 structural isolation", () => {
  it("AuthorityView has no mutation methods; evaluator cannot mint", () => {
    assertB63HasNoExecutionAuthority();
    void GUARD_B63_CANNOT_CREATE_OR_MUTATE_AUTONOMY_AUTHORITY;
    const view = createReadonlyAuthorityView({
      authority: null,
      revocations: buildEmptyRevocationLedger(),
      consumption: buildEmptyConsumptionLedger("none"),
      sellerHistories: new Map(),
    });
    for (const m of AUTHORITY_VIEW_FORBIDDEN_METHODS) {
      expect(m).toBeTruthy();
      expect(Object.prototype.hasOwnProperty.call(view, m)).toBe(false);
      expect((view as Record<string, unknown>)[m]).toBeUndefined();
    }
    const src = readFileSync(
      join(process.cwd(), "tools/trustforge/authority-policy-evaluator.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/authority-test-issuer/);
    expect(src).not.toMatch(/mintTestAutonomyAuthority|signAutonomyAuthorityForTest/);
    expect(src).toMatch(/authority-signature-verify/);
    expect(B63_PREEXISTING_BOUNDED_PAYMENT_AUTHORITY_READY_NO_PAYMENT).toBeTruthy();
  });

  it("atomic reservation required before future autonomous send", () => {
    const r = assertAtomicReservationRequiredBeforeAutonomousSend();
    expect(r.code).toBe(AUTONOMOUS_EXECUTION_REQUIRES_ATOMIC_BUDGET_RESERVATION);
    expect(PRE_JIT_AUTHORITY_REVALIDATION_CONTRACT.sequence[0]).toBe(
      "AUTONOMY_ALLOWED",
    );
    const reservation = buildAuthoritySpendReservation({
      authorityId: "a",
      authorityHash: "h",
      paymentApprovalIntentHash: "i",
      paymentAuthorityDecisionHash: "d",
      amount: "1000",
      asset: "USDC",
      network: "eip155:8453",
      createdAt: NOW.toISOString(),
      status: "RESERVED",
    });
    expect(reservation.status).toBe("RESERVED");
  });
});
