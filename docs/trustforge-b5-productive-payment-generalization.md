# TrustForge B.5 — Productive payment generalization

B.5 decides **what may be worth paying for**. B.4 executes an **exactly
authorized** payment. Those responsibilities must not collapse.

```text
DISCOVERY → NORMALIZATION → POLICY/ECONOMICS → SELECTION
  → HUMAN APPROVAL → B4 Thin Mainnet Runner → B37/B371 core
```

## Contracts

- `PaymentCandidateV1` (`tools/trustforge/payment-candidate-v1.ts`)
- Policy config: `config/trustforge_b5_candidate_policy.json` (analysis only;
  `payment_authorization: false`)
- Selection: `PaymentCandidateSelection`
- Ledger: `payment_candidate_ledger.json`

## Guards

- `GUARD_DISCOVERY_CANNOT_AUTHORIZE_PAYMENT`
- `GUARD_B5_CANNOT_SIGN` / `GUARD_B5_CANNOT_SEND` / `GUARD_B5_CANNOT_CREATE_PSA_DIRECTLY`
- `GUARD_B5_REQUIRES_SELECTED_CANDIDATE`
- `GUARD_SELECTION_CANNOT_DRIFT_AFTER_HUMAN_APPROVAL`
- `GUARD_POLICY_ELIGIBLE_IS_NOT_PAYMENT_AUTHORIZED`

## CLI

```text
npm run trustforge:b5:unpaid-discovery -- --run-dir <path>
```

Unpaid / read-only only. Does not open Approve/Reject and does not access the
signer.

## Human checkpoint

If a second live candidate is found, stop for human review. Do not treat B.5
engineering completion as payment authorization.

## Confirmed productive generalization

Classification: `B5_PRODUCTIVE_PAYMENT_GENERALIZATION_CONFIRMED`

B.5.2 proved a second seller through the generalized path (OttoAI crypto-news),
with authoritative `PaymentApprovalIntent` binding, explicit human APPROVE, and
on-chain reconciled settlement. See
`docs/trustforge-b52-ottoai-approval-binding.md` and evidence
`D:\trustforge\artifacts\runs\b52-ottoai-diversity-payment\run_20260813_072814`.
