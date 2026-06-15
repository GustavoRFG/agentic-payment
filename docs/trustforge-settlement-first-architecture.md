# TrustForge settlement-first architecture

Phase 4 codifies lessons from Phase 3 and Phase 3B into mandatory settlement-first
accounting for rich paid probes.

## Core separation

```text
payment_intent
payment_attempt
payment_bearing_request
seller_response
saved_header_evidence
chain_reconciliation
payment_integrity
semantic_evaluation
trust_score_eligibility
```

## Invariants

1. **Quote is not spend** — `quote_usdc` never becomes `actual_spend_usdc` without settlement evidence.
2. **HTTP 200 is not settlement** — seller body capture does not imply `payment_integrity: pass`.
3. **Missing tx hash is not no settlement** — triggers mandatory chain reconciliation when payment-bearing requests occurred.
4. **Rich TrustScore requires dual pass** — `payment_integrity: pass` AND `semantic_evaluation: pass`.
5. **Incomplete/fail is still evidence** — produces `EvaluationResult` and diagnostics, never a positive TrustScore.

## Phase 3/3B case study

- Zapper rich probe: seller response **not factually wrong** on core identity fields.
- Semantic status: **incomplete** (`status`, structured `amount` missing).
- Initial verifier false positives fixed in `ef10841`.
- Orchestrator failed to capture settlement tx hash from headers.
- Phase 3B reconciled **two** `0.001125 USDC` settlements via read-only Base USDC logs.
- **No positive TrustScore** was or should be created.

## Required models

- `SettlementEvidence` — `tools/trustforge/settlement-evidence.ts`
- `PaymentAttemptLedger` — `tools/trustforge/payment-attempt-ledger.ts`
- `PaymentIntegrityEngine` — `tools/trustforge/payment-integrity-engine.ts`
- `RichProbeInvariants` — `tools/trustforge/rich-probe-invariants.ts`

## Commands

```powershell
npm run trustforge:phase4:architecture
npm run trustforge:phase4:replay
npm run trustforge:rich:assert-invariants
```

## Future rich paid probes

1. Capture sanitized payment-response metadata at source.
2. Verify on-chain when tx hash present.
3. If tx hash missing and payment-bearing request count > 0, run chain reconciliation.
4. Evaluate semantic facts.
5. Only then check TrustScore eligibility.
