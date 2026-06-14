# TrustForge Status

## Thesis
TrustForge is a paid, continuous, verifiable benchmarking layer for services
consumed by autonomous agents. The core value is semantic correctness
verification of purchased third-party artifacts over time.

## Current Phase
MVP-T0C is **complete**. The first separately authorized, real, externally
settled paid x402 probe has executed, been verified on-chain, and produced the
first real `ProbeRun`, `EvaluationResult`, and `TrustScore`
(`fast-track-e2e` run `run_20260614_010720`, run id `t0c_20260613_215339`).

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
Expand from one deterministic seller to the 5–8 service registry: run unpaid
refresh probes across the registry, and add the first semantically richer paid
`ServiceEvalTask` (e.g. block-number or tx-explainer). Do not over-harden the
one-shot chain-id path further.
