# TrustForge B.6 — Agentic payment decision layer

B.6 produces an auditable **BUY / DEFER / DONT_BUY** selection over a frozen
candidate set. It does **not** authorize payment, signing, credentials, or send.

```text
candidates → normalize → policy → economics v2 → B6 decision
  → (if BUY) PaymentApprovalIntent binds selectionDecisionHash
  → human APPROVE (separate) → B.4 / B.37 / B.371
```

## Result class

`B6_AGENTIC_PAYMENT_DECISION_LAYER_READY_NO_PAYMENT`

Live unpaid evidence:
`D:\trustforge\artifacts\runs\b6-agentic-payment-decision\run_20260813_083938`

## Contracts

- `CandidateDecisionSet` — `tools/trustforge/candidate-decision-set.ts`
- `PaymentSelectionDecisionV1` — `tools/trustforge/payment-selection-decision-v1.ts`
- Policy — `config/trustforge_b6_decision_policy.json` /
  `tools/trustforge/b6-decision-policy-v1.ts` (`payment_authorization: false`)
- Economics v2 — `tools/trustforge/economic-assessment-v2.ts`
- Quote movement vs identity — `tools/trustforge/quote-observation-semantics.ts`
- Orchestration — `tools/trustforge/b6-run-decision.ts`
- Gates — `tools/trustforge/b6-execution-gates.ts`

## Semantics

| Decision | Meaning |
| --- | --- |
| BUY | Evidence justifies selecting one candidate for human review |
| DEFER | Wait / reevaluate (incomplete utility or material price rise) |
| DONT_BUY | No eligible buyable candidate in this set |

`BUY != HUMAN APPROVE != PAYMENT AUTHORIZED`.

Pre-human price movement → reevaluation. Post-human economic change →
`BLOCKED_B52_FRESH_TERMS_DIFFER_FROM_HUMAN_APPROVAL_REAUTHORIZE`.

## Live unpaid CLI

```text
npx tsx tools/run-trustforge-b6-live-unpaid-decision.ts
```

Unpaid 402 probes only. No Approve/Reject UI, no signer, no DPAPI, no payment.

## Isolation

B.6 cannot sign, access credentials, create payment headers, create PSA, or call
productive payment transport. Automated tests use
`createTestHumanPaymentDecisionProvider` only (B.5.0.1).
