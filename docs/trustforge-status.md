# TrustForge Status

## Thesis
TrustForge is a paid, continuous, verifiable benchmarking layer for services
consumed by autonomous agents. The core value is semantic correctness
verification of purchased third-party artifacts over time.

## Current Phase
Phase 3B (rich `tx_explainer` settlement reconciliation) is **complete (no-payment)**.
Phase 4 (settlement-first architecture) is **complete (no-payment)** — rich probes
require settlement evidence or chain reconciliation before TrustScore eligibility.
See `docs/trustforge-phase4-settlement-first.md` and v1 contracts under
`contracts/trustforge/*.v1.schema.json`.

Phase 5 (rich provider discovery) is **waiting for human payment decision (no-payment)**.
Unpaid discovery selected **Zapper** `zapper_tx_explainer` as the next settlement-first
rich probe candidate. See `docs/trustforge-phase5-rich-provider-discovery.md`.

Three Phase 3 paid attempts saved Zapper responses but missed settlement hashes.
Read-only chain reconciliation found **two** `0.001125 USDC` settlements; evaluation
remains `fail_after_payment_recorded` / incomplete semantic status with **no**
passing TrustScore. See `docs/trustforge-phase3b-reconciliation.md`.

Phase 3 (rich `tx_explainer` fact verification) reached paid attempts with
verifier fixes in `ef10841`; diagnostics in
`docs/trustforge-rich-tx-explainer-methodology.md`.

Phase 2 (temporal + semantically richer verification) is **complete**. A second,
separately authorized, real, externally settled paid x402 probe executed against
a different deterministic service (`onesource_api_block_number`), verified
on-chain, producing a second real `ProbeRun`, `EvaluationResult`, and per-service
`TrustScore`, plus a 2-service portfolio roll-up and per-service score history
(`phase2-temporal-semantic` run, run id `phase2_20260613_233553`).

MVP-T0C remains the immutable baseline (chain-id), preserved with a SHA-256
manifest under `trustforge/evidence/t0c_first_paid_probe/`.

## Live Proof (Phase 2 — PASS, on-chain verified)
- Second externally settled TrustForge probe (one attempt, one payment-bearing
  HTTP request, no retry, no fallback).
- On-chain USDC transfer verified on Base mainnet:
  tx `0xff5ec5e20c42aff2d6d96b7854441a0d0357178a2263f02ea381a00db12d26d4`
  (`status=success`, USDC `0x8335…2913`, `Transfer` of 1000 atomic = 0.001 USDC,
  EIP-3009 facilitator-relayed, authorizer fingerprint `49b14ebd8f578d41`).
- Semantically richer verification: observed Ethereum L1 block `25313317` fell
  inside the independent before/after `eth_blockNumber` window (±5 tolerance,
  ≥2 independent RPC confirmations); `semantic_correctness: pass`.
- Block-number `ServiceEvalTask` evaluated: composite `1.0`, status `pass`.
- Per-service `TrustScore`: composite `1.0`, `sample_size=1`, `confidence=low`,
  `regression_flag=false`. Portfolio score across 2 services: composite `1.0`,
  `total_sample_size=2`. Evidence: `trustforge/evidence/phase2_second_deterministic_probe/`.
- New machinery: verification profiles (`ethereum_chain_id`, `ethereum_block_number`),
  unpaid registry refresh tool, deterministic service selection, temporal score
  history + portfolio roll-up — all unit-tested (238 passing).

## Live Proof (MVP-T0C — PASS, on-chain verified)
- First externally settled TrustForge probe completed (one attempt, one
  payment-bearing HTTP request, no retry, no fallback).
- On-chain USDC transfer verified on Base mainnet:
  tx `0xb445f8c1091a55ac35d23db38371a0e0d0bbb0bf2564e3ddf9843abea70cfb11`
  (`status=success`, USDC `0x8335…2913`, `Transfer` of 1000 atomic = 0.001 USDC,
  authorizer fingerprint matches the buyer wallet).
- Seller returned HTTP 200 with chain id `0x1`; independent `eth_chainId` ground
  truth before and after both equalled 1; `semantic_correctness: pass`.
- First deterministic `ServiceEvalTask` evaluated: composite `1.0`, status `pass`.
- First bootstrap `TrustScore` generated: composite `1.0`, `sample_size=1`,
  `confidence=low`.
- Evidence: `trustforge/evidence/t0c_first_paid_probe/`.

## Mocked Proof
- CLI routing separates readiness-only dependencies from paid dependencies.
- Gate order keeps wallet loading after policy, handshake, ground truth before,
  arming, and run id checks.
- Paid execution is one-shot with payment attempts and payment-bearing HTTP
  requests capped at one.
- Post-payment failures write evidence and do not retry or fallback.
- HTTP 200, actual spend, settlement evidence or receipt, and semantic chain id
  correctness are required for PASS.

## Scope Boundaries (honest)
- Exactly one paid external probe has settled. `sample_size=1`, `confidence=low`;
  this is a bootstrap signal, not a stable TrustScore.
- Only one seller and one deterministic task (`onesource_api_chain_id` /
  `ethereum_chain_id_v1`) have a real evaluation. The rest of the registry is
  proven by unpaid handshake only.
- Per-request latency was not captured by the one-shot executor (`latency_ms:
  null`); the active task has no latency verifier, so the composite is unaffected.

## Binding Status
Binding paid real: complete. MVP-T0C live execution: complete and on-chain
verified.

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

A real `TrustScore` now exists at
`trustforge/evidence/t0c_first_paid_probe/trust_score.json` (also written locally
to the git-ignored `trustforge/runtime/scores/`). `trustforge:contracts:validate`
now detects and validates it (`real_score_created: yes`). Mock fixtures under
`trustforge/fixtures/` still exercise the pipeline independently of the real run.

## Next Step
Proceed to a separate OATP `tx_explainer` paid probe (see
`docs/trustforge-oatp-tx-explainer-plan.md`) with a higher explicit cap, richer
on-chain fact verifiers (deterministic + tolerance), and no LLM-judged score for
prose quality yet. It requires a registry unpaid handshake and a separate
explicit paid authorization. To raise confidence on the existing services,
repeat probes on the same `service_id` to grow `sample_size` and exercise the
temporal regression/consistency detection.

## A.3 request-shape binding (2026-08-02)

The thin settlement pipeline now treats the discovered invocation shape as a
fail-closed authorization boundary. Discovery persists canonical endpoint,
method, query, body, provenance, and SHA-256 binding; adapt probes consume that
same shape; the selected candidate and authorization draft preserve it; and the
planner, settlement intent, and actual outbound request must all reproduce the
same hash before any key guard or network request can run. Legacy artifacts
without a persisted binding are rejected instead of receiving an implicit `{}`
input. This corrective was implemented and tested without live operations or
payment-bearing requests.
