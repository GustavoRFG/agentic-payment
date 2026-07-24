# Reconciliation availability — diagnosis & robustness

Context: three symptoms in sequence — persistent `RECONCILIATION_RPC_TIMEOUT` across
two distinct RPCs, then a raw exception `reconciliation failed` at
`tools/trustforge/x402-classify-runner.ts:147`, plus a libuv teardown assertion
(`async.c:76`) seen during the prior adapt run.

## (i) What reconciliation actually queries — the "RPC" label is accurate

`tools/trustforge/onchain_settlement_reconciliation.py` uses **JSON-RPC only**:
`eth_getLogs`, `eth_call`, `eth_getBlockByNumber`, `eth_getTransactionReceipt`,
issued with `urllib.request.urlopen` against the Base RPC endpoints
(`TRUSTFORGE_BASE_RPC_URL` + fallbacks). It makes **no facilitator/CDP call** —
there is not a single facilitator reference in the reconciler.

The facilitator receipt is a **local artifact** (`facilitator_receipt_<attemptId>.json`)
loaded separately by `loadFacilitatorReceipt`. So `facilitator_receipt_parse_status: missing`
means "no local receipt to bind against" — it does **not** imply a live facilitator
dependency, and the timeout is **not** coming from the facilitator. The
`RECONCILIATION_RPC_*` family of labels is therefore correct as to subsystem.

Refinement kept: the TypeScript-side timeout is a **bounded process deadline** (the
spawn is killed), so the timeout ledger detail now says exactly that and states it
is an RPC-only reconciler, not a facilitator/CDP call — so the label can't be
misread as a facilitator timeout.

## (ii) Line 147 threw instead of emitting a structured verdict

The old path `throw new Error(result.stderr || "reconciliation failed")` fired when the
reconciler exited non-zero **without** writing a ledger. A thrown stack trace is not
a fail-closed verdict — it aborts classification with no `RESULT`.

Fix: `materializeReconcileLedger` (in `reconciliation-availability.ts`) turns every
unavailable-reconciler case into a **structured, fail-closed ledger**:

- timed out → `RECONCILIATION_RPC_TIMEOUT`
- non-zero exit, no ledger → `RECONCILIATION_SUBPROCESS_FAILED`, whose
  `reconciliation_detail` names the real cause (`exit_code`, `signal`, first stderr line)
- ok, or reconciler wrote its own ledger → use that ledger

`RECONCILIATION_SUBPROCESS_FAILED` is added to the classify-runner's unavailability
gate (`isReconciliationUnavailableStatus`), so it flows to
`BLOCKED_RECONCILIATION_UNAVAILABLE` with `safe_to_use_for_payment_verification: false`.
`RESULT.txt` now also prints `reconciliation_detail`, surfacing the real cause.

## (iii) libuv `async.c:76` teardown assertion

The adapt probes bounded their `fetch` with `setTimeout(() => controller.abort())` and
cleared it in `finally`, but the timer was **referenced**. A referenced deadline timer
keeps the event loop alive; under the `singleFork` vitest pool (one worker for the whole
suite) a live handle racing worker teardown can trip libuv's self-pipe assertion
(`async.c`), taking the whole suite down.

Fix: `startAbortDeadline` (in `abort-deadline.ts`) `unref()`s the timer — it can never
hold the loop open — and still `clear()`s it on the normal path. Both adapt probes
(`paid-method-honored-probe.ts`, `quote-stability-probe.ts`) now use it. The same
non-`unref`'d `setTimeout(() => controller.abort())` pattern lived in four other probe
sites (`external-x402-get-adapter.ts`, `refresh-registry-unpaid.ts`,
`rich-tx-explainer-handshake.ts`, `target-liveness.ts`); each now `unref()`s its deadline
timer so the whole suite's teardown-race surface is closed. The reconcile spawn is
`spawnSync` (self-contained, synchronous) and is not part of this teardown race.

## Scope

The settlement executors are untouched. Changes are confined to reconciliation ledger
materialization, the classify-runner wiring, and the probe deadline timers.
