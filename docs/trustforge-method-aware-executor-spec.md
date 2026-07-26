# SPEC (proposal — not implemented): method-aware thin settlement executor

Status: **proposal for human review.** No executor code is changed by this document.
The short-term guard (A.1) already rejects non-POST catalog candidates before they
are probed; this spec is the durable fix that would let them settle.

## Problem

The thin settlement executor (`tools/trustforge/x402-thin-settlement-executor.ts`)
sends the paid settlement request with a hard-coded `POST`
(`SETTLEMENT_PAID_HTTP_METHOD`). The bazaar catalog, however, declares a `method`
per candidate (`TargetCandidate.method`: GET | POST | PUT | PATCH | DELETE | HEAD).
When a candidate's catalog method is GET (or any non-POST), settle POSTs to a route
that only serves GET → HTTP 405. This is the root cause of the observed 405s
(`api.onesource.io`, runs `run_20260723_153238` / `run_20260724_005838`): our own
verb mismatch, not a seller defect (see the blocklist entry's `reinterpretation`).

Today ~19 of the 82 catalog candidates are POST-settleable; the remaining ~63 are
excluded purely because settle cannot speak their method. A method-aware executor
would open **63/82** additional candidates.

## Proposed change (executor — requires human review)

1. Thread the selected candidate's `method` into the paid request instead of the
   `POST` constant. Concretely, `executeThinX402Settlement` reads
   `selected.method` (already carried on `DiscoveredSelectedCandidate`) and issues
   the paid request with that verb, defaulting to POST when absent.
2. Body/URL handling per verb: POST/PUT/PATCH carry the JSON body; GET/HEAD carry
   no body and move any required parameters to the query string (as the keyless
   handshake already does for GET probes).
3. Keep the keyless settle-method probe (A.1's `paid-method-honored-probe`) aligned:
   probe with the *same* verb the executor will use, so a 404/405/501 still gates
   before payment. `isMethodSupportedByThinRunner` would widen from "POST only" to
   "any verb the executor implements".
4. Idempotency/safety: only verbs that the x402 settlement semantics define as safe
   to retry under a single human authorization should be enabled at first
   (POST + GET). PUT/PATCH/DELETE stay gated until reviewed per-method.

## Why this is gated behind human review

- It changes money-moving behavior in the executor, which is deliberately treated
  as a review boundary (every other task in this series keeps the executor
  untouched). A wrong verb or body placement could submit a malformed paid request.
- It widens the settleable surface 4× (19 → 82), so the blast radius of a bug grows
  with it.

## Rollout, once approved

1. Implement the executor change behind the existing keyless method probe.
2. Re-probe the 63 newly-eligible candidates keyless (no payment) to confirm the
   catalog method matches a live 402 on that verb.
3. Re-evaluate the `api.onesource.io` blocklist entry with fresh evidence; if the
   GET settle now succeeds keyless, removal becomes a human decision.
4. Retire the A.1 `REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER` gate (or narrow it to
   verbs the executor still does not implement).
