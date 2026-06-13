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
- evidence written on success and post-payment failure;
- private keys never printed or persisted.

## Workspace
Source repo remains at `D:\agentic-payments-lab`.
Artifacts live under `D:\trustforge\artifacts\runs`.
Do not create new TrustForge scratch directories directly under `D:\`.

## Current roadmap
1. close real paid binding;
2. execute one authorized T0C payment;
3. verify transfer on-chain;
4. add registry for 5-8 services;
5. implement first ServiceEvalTask;
6. produce EvaluationResult;
7. add temporal TrustScore;
8. expose Trust API later.

## Anti-goals
- no infinite readiness layering;
- no generic wallet framework before T0C;
- no dashboard before score artifacts exist;
- no public score publication before methodology and legal review;
- no broad refactor without need.

## Bootstrap pipeline status (fast-track-e2e, 2026-06-13)
The deterministic registry, JSON Schema contracts, evaluator, and TrustScore
consolidator are implemented and tested ahead of T0C so the first paid run is
short. This is scaffolding only: no real `TrustScore` is created until a real,
authorized, on-chain-verified paid probe exists (`REAL_SCORE_NOT_CREATED`).
Handshake success and mock fixtures are never presented as live settlement.
