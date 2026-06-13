# TrustForge Status

## Thesis
TrustForge is a paid, continuous, verifiable benchmarking layer for services
consumed by autonomous agents. The core value is semantic correctness
verification of purchased third-party artifacts over time.

## Current Phase
The project is at real paid binding readiness for the external one-shot x402
probe. The next phase is MVP-T0C: one separately authorized real paid external
smoke.

## Live Proof
- Unpaid external `402` dry-run is permitted and expected.
- External paid readiness is permitted only in `--readiness-only` mode.
- This phase does not prove live settlement, live wallet loading, or live
  signed payment headers.

## Mocked Proof
- CLI routing separates readiness-only dependencies from paid dependencies.
- Gate order keeps wallet loading after policy, handshake, ground truth before,
  arming, and run id checks.
- Paid execution is one-shot with payment attempts and payment-bearing HTTP
  requests capped at one.
- Post-payment failures write evidence and do not retry or fallback.
- HTTP 200, actual spend, settlement evidence or receipt, and semantic chain id
  correctness are required for PASS.

## Not Yet Proven
- No MVP-T0C live paid external payment has been executed in this phase.
- No live dedicated wallet has been loaded for this external smoke in this
  phase.
- No on-chain transfer has been verified for the external OneSource smoke.

## Binding Status
Binding paid real: complete, pending only separately authorized MVP-T0C live
execution.

## Bootstrap Pipeline (ready — fast-track-e2e run 2026-06-13)
The deterministic benchmarking pipeline is now implemented and tested ahead of
the first paid settlement, so the next paid run is short:

- contracts: `contracts/trustforge/{probe_run,service_eval_task,evaluation_result,trust_score,service_registry}.schema.json`
  (JSON Schema draft 2020-12), validated by a dependency-free validator and the
  `trustforge:contracts:validate` script;
- registry: `trustforge/registry/services.bootstrap.json` — 8 sellers proven by
  unpaid handshake in spike-zero (OneSource chain-id/block-number/network-info,
  OttoAI token-price/hyperliquid, Blockrun, Anchor, Memory weather);
- ServiceEvalTask: `trustforge/tasks/onesource_api_chain_id/ethereum_chain_id_v1.json`;
- evaluator: `tools/trustforge/evaluate-bootstrap-probe.ts` (LLM-free, deterministic);
- consolidator: `tools/trustforge/consolidate-bootstrap-trust-score.ts`;
- 45 new unit tests; full suite 208 passed / 1 skipped by design.

No real `TrustScore` exists yet — only mock fixtures under
`trustforge/fixtures/` exercise the pipeline. `REAL_SCORE_NOT_CREATED`. External
paid execution remains human-gated; no live external settlement is claimed.

## Next Step
Run MVP-T0C as a separate explicitly authorized single paid external smoke with
a dedicated wallet, a max total spend of 0.005 USDC, max payment attempts of 1,
and post-settlement on-chain verification. The registry, contracts, evaluator,
and score pipeline are already in place, so the paid run goes straight to the
single attempt, on-chain verification, the first real ProbeRun, and the first
real TrustScore (`sample_size=1`, `confidence=low`).
