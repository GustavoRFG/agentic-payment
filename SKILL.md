# TrustForge Engineering Skill

## Mission
Build a paid, continuous, verifiable benchmarking layer for services consumed by autonomous agents.

## Product thesis
TrustForge is not primarily a marketplace, payment protocol, uptime monitor, or generic reputation score.
Its core value is semantic correctness verification of purchased artifacts over time.

## Execution style
- Prefer long, complete, spec-driven implementation loops.
- Inspect first, then implement, validate, repair, and commit.
- Do not fragment reversible engineering work into unnecessary micro-MVPs.
- Continue autonomously through test failures when corrections are local and safe.
- Escalate only decisions that require human judgment, money authorization, secrets, or irreversible external effects.

## Decision hierarchy
1. Preserve user funds and secrets.
2. Preserve evidence and auditability.
3. Advance the end-to-end circuit.
4. Prefer deterministic verification.
5. Prefer reuse over duplication.
6. Keep paid paths fail-closed.
7. Keep readiness and paid execution separated.
8. Avoid premature platform expansion.
9. Do not confuse mocked validation with live proof.
10. Do not confuse handshake success with semantic correctness.

## Human-only decisions
- authorizing real payment;
- funding a dedicated wallet;
- selecting public/private publication;
- selecting commercial independence policy;
- legal review before publishing third-party scores;
- pricing and business positioning.

## Autonomous loops
Agents should run inspect -> edit -> focused tests -> diagnose -> repair -> full tests -> build -> live unpaid checks -> diff review -> commit.
Use up to 6 repair loops when progress is measurable.
Stop earlier on repeated identical failure without progress.

## Safety invariants
- maxPaymentAttempts = 1 for MVP-T0C;
- no retry after payment-bearing request;
- no paid fallback;
- exact URL allowlist;
- GET only for initial external probe;
- Base mainnet eip155:8453 only;
- USDC only;
- total spend cap <= 0.005 USDC for initial smoke;
- ground truth before and after;
- HTTP 200 required;
- semantic correctness required;
- receipt or documented settlement evidence required;
- actual spend validation required;
- quote_usdc is never actual_spend_usdc without settlement evidence;
- HTTP 200 seller body is not payment proof;
- missing saved tx hash requires chain reconciliation before concluding no settlement;
- rich TrustScore requires payment_integrity pass and semantic_evaluation pass;
- evidence written on success and post-payment failure;
- private keys never printed or persisted.

## Workspace
Source repo remains at `D:\agentic-payments-lab`.
Artifacts live under `D:\trustforge\artifacts\runs`.
Do not create new TrustForge scratch directories directly under `D:\`.

## Current roadmap
1. close real paid binding; ✅
2. execute one authorized T0C payment; ✅
3. verify transfer on-chain; ✅
4. add registry for 5-8 services; ✅ (8 services, unpaid refresh tool)
5. implement first ServiceEvalTask; ✅ (chain-id + block-number)
6. produce EvaluationResult; ✅ (two real evaluations)
7. add temporal TrustScore; ✅ (per-service history + portfolio roll-up + regression/consistency)
8. richer paid probe — OATP `tx_explainer` (Phase 3 paid attempts; Phase 3B reconciliation; Phase 4 settlement-first architecture — no passing TrustScore);
9. expose Trust API later.

## Anti-goals
- no infinite readiness layering;
- no generic wallet framework before T0C;
- no dashboard before score artifacts exist;
- no public score publication before methodology and legal review;
- no broad refactor without need.

## Bootstrap pipeline status (fast-track-e2e)
The deterministic registry, JSON Schema contracts, evaluator, and TrustScore
consolidator are implemented and tested. As of run `run_20260614_010720`
(2026-06-14), MVP-T0C is **complete**: one authorized, on-chain-verified paid
probe (tx `0xb445f8c1…0cfb11`, 0.001 USDC) produced the first real `ProbeRun`,
`EvaluationResult`, and `TrustScore` (composite `1.0`, `sample_size=1`,
`confidence=low`), committed under `trustforge/evidence/t0c_first_paid_probe/`.
Mock fixtures still exercise the pipeline independently and are never presented
as live settlement.

## Phase 2 status (phase2-temporal-semantic)
Phase 2 is **complete** (run id `phase2_20260613_233553`). A second authorized,
on-chain-verified paid probe against `onesource_api_block_number` (tx
`0xff5ec5e2…26d4`, 0.001 USDC) used a new tolerance-window verification profile,
produced a second real `ProbeRun`/`EvaluationResult`/`TrustScore`, a 2-service
portfolio roll-up, and per-service score history with regression/consistency
detection. Verification profiles (`ethereum_chain_id`, `ethereum_block_number`)
generalize the executor; selection and refresh are deterministic and tested.
The same one-shot/no-retry/no-fallback invariants apply; the 0.005 USDC cap is
the OneSource deterministic cap and is **not** reused for OATP (separate higher
cap + separate authorization).
