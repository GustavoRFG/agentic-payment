# TrustForge Status

## Thesis
TrustForge is a paid, continuous, verifiable benchmarking layer for services
consumed by autonomous agents. The core value is semantic correctness
verification of purchased third-party artifacts over time.

## Current Phase
Seller requirements binding B.1 plus corrective R1 are implemented in
no-payment mode. x402 v1/v2 seller requirements are version-validated and
canonically bound without requiring seller `nonce`/`expiresAt`. v1 `base` and
`base-sepolia` are mapped explicitly to their CAIP-2 execution identities while
the raw seller value remains inside the requirements/envelope hashes; v2 accepts
only the exact supported CAIP-2 identifiers. Selection-time observations may
age during human review, but a fresh exact-hash unsigned 402 is required
immediately before future signing.

B.2 pipeline implementation is complete. Independent offline audit
`PASS_B2_OFFLINE_AUDIT` is recorded under
`D:\trustforge\artifacts\runs\b2-offline-audit\run_20260806_030405`.

Activation state (do not collapse these into a single ambiguous “B.2 active”):

- B.2 pipeline implementation: complete
- B.2 prepare-only production activation: active
  (`config/trustforge_b2_activation_policy.json`)
- B.2 real signing: inactive (`BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED`)
- B.2 payment-bearing send: inactive
  (`BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED`)
- B.2 settlement: inactive (`BLOCKED_B2_SETTLEMENT_NOT_AUTHORIZED`)
- B.2 pre-sign gate: `UNSIGNED_PERSISTED` is never signable without current-time
  validation (`buyer-pre-sign-validation.ts`)
- B.3 signer boundary: ready and inactive
  (`config/trustforge_signer_activation_policy.json`;
  `real_signing_enabled=false`, credential provider unauthorized)
- B.3 signing authorization: contract implemented; no operational signing
  authorization for a live candidate
- B.3 post-sign send gate: `BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED`
- B.3.1 credential provider: configured and inactive
  (`config/trustforge_buyer_credential_provider_policy.json`;
  `credential_access_enabled=false` → `BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED`)
- B.3.1 credential-access authorization: contract implemented; no operational
  credential-access authorization for a live candidate
- B.3.2 signer mechanism registry: ready and inactive
  (explicit provider IDs; `real_backend_activation=false`,
  `selected_productive_provider_id=NONE`; real adapters terminate at
  `BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE`)

Productive prepare may reserve an attempt and persist an unsigned artifact only
with a valid activation policy, concrete human payment authorization, and an
injected fresh pay-time observation. It never loads a private key, never creates
a payment header, and never sends. Historical paid-core tests reach
implementation cores only through `tests/support/`.

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

The A.3 corrective completed the same boundary for the legacy rich caller: its
runtime planner now receives the authorized hash and summary from the persisted
Phase 5/6 human artifact and compares them before wallet loading. Query
canonicalization sorts distinct keys while preserving repeated-value order and
multiplicity, and authorization summaries are compared by their canonical
semantic hash rather than textual property order.
