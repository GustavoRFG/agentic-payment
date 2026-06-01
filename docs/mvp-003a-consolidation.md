# MVP 003A - Consolidation Sprint

## Purpose

MVP 003A moves repeated safety rules and regression checks out of prompts and
large one-off orchestration scripts. The goal is to make the next controlled
payment milestone depend on code-level invariants, automated tests, and a
shared seller harness.

## Safety invariants in code

The canonical payment and environment safety values now live in:

```text
seller-api/src/config/safety.ts
```

This module defines the Base Sepolia network, USDC payment amount, maximum
payment attempts, sensitive environment variable names, forbidden snapshot
markers, mainnet detection, and environment sanitization.

## Test isolation mode

`seller-api`, `buyer-client`, and wallet-check entry points now use a small
dotenv loader that respects:

```text
AGENTIC_SKIP_DOTENV=1
```

The test harness always sets this flag. Tests do not read local `.env` files.

## Vitest coverage

The root test suite covers:

- safety config and environment sanitization;
- snapshot v1 validation and secret-marker detection;
- risk scoring semantics around unknown pool liquidity;
- mock seller endpoint behavior;
- unpaid paid-endpoint HTTP 402 requirements;
- adapter-real-file fixture behavior and honest fallback.

## Shared seller harness

The shared local seller harness lives in:

```text
tools/_lib/seller-harness.ts
```

It allocates a free local port, pins Base Sepolia and the `$0.001` USDC price,
sets `AGENTIC_SKIP_DOTENV=1`, sanitizes inherited environment variables, waits
for `/health`, and stops the seller process reliably.

## Safe demos migrated

The safe non-paying demo scripts now use the shared harness:

- `tools/run-local-demo.ts`
- `tools/run-real-file-demo.ts`
- `tools/run-real-local-snapshot-demo.ts`
- `tools/run-paid-real-local-dry-run.ts`

The controlled payment executor was preserved and was not executed. It only
imports the centralized safety constants.

## Scoring semantic fix

The adapter no longer maps `positionValueUsd` to `liquidityUsd`.

`positionValueUsd` is the value of the monitored LP position. It is not the
same as pool depth. Snapshot v1 now accepts optional `poolLiquidityUsd`; when a
snapshot lacks pool liquidity, scoring records `Pool liquidity unknown.` and
does not apply the low-liquidity penalty.

Earlier dashboard scores may have looked high because small LP position value
was treated as low pool liquidity. MVP 003A corrects that semantic mapping.

## Dashboard artifact hygiene

`dashboard/index.html` is now generated locally by `dashboard:render` and is
not tracked. The stable representative dashboard artifact remains the committed
screenshot under `docs/screenshots/`.

## Intentionally not run

MVP 003A did not run:

- any x402 payment;
- the valid controlled-payment confirmation token;
- `snapshot:refresh:local`;
- real-local demo commands that read `runtime/`;
- any command that reads or modifies `D:\defi_guardian`;
- wallet, signing, broadcast, watcher, RPC, or MongoDB write paths.

No x402 payment was executed. No valid controlled-payment confirmation token
was used. `D:\defi_guardian` was not read or modified. Actual local snapshots
were not accessed.

## Branching note

The `pre-003a-baseline` tag marks the state before this consolidation. The
project can fast-forward the long-lived branch after MVP 003B validates the
controlled payment through the new gated test path.

## Next milestone

Recommended next steps:

- MVP 003A.1: run an opt-in real-local regression using the approved read-only
  snapshot exporter, then compare results after the scoring fix.
- MVP 003B: replace the bespoke controlled payment execution with one gated
  integration test and run exactly one Base Sepolia payment only after explicit
  approval.
