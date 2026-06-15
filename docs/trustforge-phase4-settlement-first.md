# TrustForge Phase 4 — Settlement-First Architecture

Phase 4 transforms Phase 3 / Phase 3B lessons into mandatory settlement-first
architecture. No positive rich TrustScore is emitted unless both payment integrity
and semantic evaluation pass.

## Why Phase 4 exists

Phase 3 proved unpaid liveness and built fact verification, but paid attempts saved
seller responses without reliable settlement tx hash capture. Phase 3B reconciled
**two** `0.001125 USDC` settlements on Base via read-only chain logs. Phase 4
codifies the rule: **settlement evidence before TrustScore**.

## What Phase 3/3B taught

- HTTP 200 seller body is not payment proof.
- `quote_usdc` is never `actual_spend_usdc` without settlement evidence.
- Missing saved tx hash requires chain reconciliation before concluding settlement.
- Zapper rich probe: semantic status **incomplete**; no passing TrustScore.
- Reconciled settlement hashes (offline replay only):
  - `0x9b605be3d78e4b64168842548612f3ceb671c61df8fab069aa7a815d934c35ed`
  - `0x8f5edd95fb36ae7bcc129dc600ec7815db5d979ffe6cd7088b711ff94a0c2b86`

## Settlement-first rule

```text
No payment integrity pass  → no TrustScore
No semantic evaluation pass → no TrustScore
Payment without reconciliation → no TrustScore
Seller response without settlement → no TrustScore
Settlement with wrong semantics → no TrustScore
```

## Models

### SettlementEvidence (`settlement_evidence.v1`)

Canonical settlement proof. Adapters in `tools/trustforge/settlement-first-v1.ts`
map from legacy Phase 3B evidence. Fixtures:

```text
trustforge/fixtures/phase4_settlement_replay/settlement_0x9b605b35ed.json
trustforge/fixtures/phase4_settlement_replay/settlement_0x8f5edd2b86.json
```

### PaymentAttemptLedger (`payment_attempt_ledger_entry.v1`)

Per-attempt accounting with policy flags and safety counters. Replay fixture:

```text
trustforge/fixtures/phase4_settlement_replay/payment_attempt_ledger_phase3b.json
```

### PaymentIntegrityEngine (`payment_integrity_result.v1`)

Deterministic, offline, no network, no wallet, no payment headers.
`tools/trustforge/settlement-first-v1.ts` → `runPaymentIntegrityEngine()`.

### TrustScore blocking (`blocked_trust_score_result.v1`)

`evaluateTrustScoreCreation()` returns `{ trust_score_created: true }` only when
both gates pass; otherwise a blocked artifact with explicit `blocked_reason`.

## Rich probe invariants (RICH-001..010)

| ID | Invariant |
|----|-----------|
| RICH-001 | No TrustScore without payment_integrity pass |
| RICH-002 | No TrustScore without semantic_evaluation pass |
| RICH-003 | No wallet load in no-payment Phase 4 |
| RICH-004 | No payment header sent in no-payment Phase 4 |
| RICH-005 | No retry/fallback against Zapper in Phase 4 |
| RICH-006 | Settlement replay hashes match ledger evidence |
| RICH-007 | Zero payment-bearing HTTP requests in no-payment replay |
| RICH-008 | Phase 3B replay creates no new transaction hash |
| RICH-009 | Rich TrustScore points to immutable SettlementEvidence |
| RICH-010 | Paid seller response tied to one PaymentAttemptLedger entry |

Implemented in `tools/trustforge/phase4-rich-invariants.ts`.

## Commands (no payment)

```powershell
$env:TRUSTFORGE_PHASE4_NO_PAYMENT="YES_STRICTLY_NO_PAYMENT"
$env:TRUSTFORGE_DISABLE_PAID_EXECUTION="YES"

npm run trustforge:phase4:replay
npm run trustforge:phase4:invariants
npm run trustforge:phase4:architecture
npm run trustforge:contracts:validate
npm test
```

**Forbidden in Phase 4:**

- `npm run trustforge:rich-tx-explainer:paid`
- `--execute-paid`
- Loading `BUYER_PRIVATE_KEY`
- Zapper paid retry

## Offline replay procedure

1. Load settlement fixtures from `trustforge/fixtures/phase4_settlement_replay/`.
2. Run `npm run trustforge:phase4:replay`.
3. Replay writes to `D:\trustforge\artifacts\runs\phase4-settlement-first\run_<ts>\`.
4. Assert: wallet not loaded, no payment header, no new tx hash, two settlements replayed.

## No-payment guarantees

- `TRUSTFORGE_PHASE4_NO_PAYMENT=YES_STRICTLY_NO_PAYMENT` enforced.
- Dangerous env vars cleared before replay/invariants.
- `payment_bearing_http_request_count` forced to 0 in no-payment replay ledger entries.
- No RPC calls in replay tool (uses committed fixtures + existing offline replay).

## Known limitations

- Phase 3B semantic evaluation remains **incomplete** for Zapper responses (missing
  `status`, structured `amount` fields). TrustScore correctly blocked.
- Third paid attempt (`run_20260614_215039`) has no mapped settlement.
- v1 schemas coexist with legacy Phase 3B models; adapters preserve backward compatibility.

## Next phase recommendation

Phase 5: new rich probe with explicit human authorization, settlement header capture
at source, and a provider that exposes reconcilable settlement metadata — only after
Phase 4 invariants pass in CI.

See also: `docs/trustforge-settlement-first-architecture.md`.
