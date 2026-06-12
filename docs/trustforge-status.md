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

## Next Step
Run MVP-T0C as a separate explicitly authorized single paid external smoke with
a dedicated wallet, a max total spend of 0.005 USDC, max payment attempts of 1,
and post-settlement on-chain verification.

Do not expand the registry before MVP-T0C.
