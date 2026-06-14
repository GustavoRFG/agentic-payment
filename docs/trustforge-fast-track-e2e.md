# TrustForge Fast-Track End-to-End

This document records the `fast-track-e2e` executions. Run 1 (2026-06-13) built
the deterministic benchmarking pipeline up to the human-gated paid T0C smoke.
Run 2 (2026-06-14, `run_20260614_010720`) executed the authorized paid T0C smoke
end-to-end.

## Outcome (Run 2 — current)

`PASS_REAL_SCORE`

- The first real external paid probe settled on Base mainnet and was verified
  on-chain (tx `0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11`,
  `ONCHAIN_VERIFIED`, 0.001 USDC, one attempt, no retry/fallback).
- First deterministic `ServiceEvalTask` evaluated → `EvaluationResult` (composite
  `1.0`, status `pass`).
- First real `TrustScore` consolidated (composite `1.0`, `sample_size=1`,
  `confidence=low`).
- Evidence committed under `trustforge/evidence/t0c_first_paid_probe/`.

### Run 2 steps

1. Verified the three T0C authorization gates were armed and the dedicated wallet
   key was loadable; loaded it for a single executor invocation (not persisted,
   not printed). Confirmed via `AskUserQuestion` because the key was stored in an
   unexpected form/location.
2. Unpaid dry-run PASS (HTTP 402, quote 0.001 USDC, eip155:8453, USDC).
3. Single `--execute-paid` run → full state machine to `PASS`
   (`INIT → … → PAYMENT_RESPONSE_RECEIVED → RECEIPT_OR_SETTLEMENT_EVIDENCE_VALIDATED
   → GROUND_TRUTH_AFTER_CONFIRMED → SEMANTIC_VERIFICATION_COMPLETED → PASS`).
4. On-chain verification via Base RPC `eth_getTransactionReceipt` — see
   `trustforge/evidence/t0c_first_paid_probe/onchain_verification.md`.
5. Built the real `ProbeRun`, ran the evaluator and score CLIs, validated all
   outputs against contracts (`real_score_created: yes`).
6. Full suite 208 passed / 1 skipped; seller/buyer/mcp builds green;
   `git diff --check` clean.

## Outcome (Run 1 — historical)

`PASS_BOOTSTRAP_READY_HUMAN_GATE_T0C`

- External paid execution was human-gated. No wallet was loaded, no payment
  header was sent, no settlement was attempted.
- The registry, contracts, bootstrap evaluator, and score pipeline were made
  ready. No real `TrustScore` existed yet; only mock fixtures exercised the
  pipeline.

## What was completed (non-financial)

1. Governance read; `AGENTS.md` created in both repo and workspace.
2. Git snapshot — lab repo at the expected `4a19dee` on
   `mvp-007a-local-paid-mcp-gateway`, clean tree.
3. Secret hygiene — PASS. No tracked real `.env`, no leaked keys; only public
   tx hashes in docs and an obvious test-dummy key. `gitleaks` not available.
4. Private backup — authorization absent; origin preserved, no push; manual
   commands recorded.
5. Binding audit — all 27 checklist items PASS; `livePaidDependencies` bound to
   the real x402 EVM transport behind the one-shot payment-bearing guard.
6. Unpaid validation — dry-run and paid-readiness both PASS (HTTP 402, quote
   0.001 USDC, eip155:8453, USDC, wallet not loaded).
7. Contracts — 5 JSON Schemas + dependency-free validator +
   `trustforge:contracts:validate`.
8. Registry — 8 sellers proven by unpaid handshake in spike-zero.
9. ServiceEvalTask, evaluator (`trustforge:evaluate:bootstrap`), and TrustScore
   consolidator (`trustforge:score:bootstrap`) with deterministic rules.
10. Tests — 45 new unit tests; full suite 208 passed, 1 skipped by design.
11. Builds — seller/buyer/mcp builds and contracts validation all green;
    `git diff --check` clean.

## Human gate that remains (T0C)

To produce the first real probe and TrustScore, a human must (see
`docs/trustforge-human-decisions.md`):

1. fund a dedicated wallet with a small controlled USDC balance on Base mainnet;
2. configure `BUYER_PRIVATE_KEY` locally via the secure loader (never commit);
3. set `TRUSTFORGE_AUTHORIZE_T0C`, `TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED`, and a
   unique `TRUSTFORGE_T0C_RUN_ID` for the session;
4. re-run the same spec. The paid run then goes straight to one attempt
   (≤ 0.005 USDC), on-chain verification, a real ProbeRun, and the first real
   TrustScore.

## Pipeline reference

| Stage | Command |
|---|---|
| Validate contracts | `npm run trustforge:contracts:validate` |
| Evaluate a probe | `npm run trustforge:evaluate:bootstrap -- --probe-run <path> --task <path>` |
| Consolidate score | `npm run trustforge:score:bootstrap -- --eval <path>` |

Methodology version: `trustforge-bootstrap-v0.1.0`.
