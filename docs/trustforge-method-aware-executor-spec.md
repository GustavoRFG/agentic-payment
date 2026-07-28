# SPEC: method-aware thin settlement executor

Status: **core implemented off-executor + tested; wiring awaits human review.**
The pure request-shaping logic (verb selection, GET query placement, safe-verb
gating) now lives in `tools/trustforge/thin-settlement-request-plan.ts` with unit
tests — no key, wallet, network, or payment. The remaining step is money-moving and
kept behind human review: wiring the planner into the executor and widening the
adapt gate. The payment executor (`x402-thin-settlement-executor.ts`) is unchanged.
The short-term guard (A.1) still rejects non-POST catalog candidates before probing.

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

## What is implemented (off-executor, this commit)

`thin-settlement-request-plan.ts` exports:
- `planThinSettleRequest({ method, endpoint, body })` → `{ supported, method, endpoint, body, sendBody }`
  (POST default; GET moves params to the query and carries no body; PUT/PATCH/DELETE/HEAD → `supported: false`).
- `isThinRunnerSettleableMethod` / `THIN_RUNNER_SETTLEABLE_METHODS` (`["POST","GET"]`) — the single
  source of truth for the enabled verbs, so the adapt gate can delegate to it.

Deliberately NOT done (money-moving / human-review-gated): the executor is not
wired to the planner, and the A.1 gate is not widened. Doing either before the other
would re-open the 405 (a widened gate lets non-POST candidates reach a still-POSTing
settle), so both must land together under review.

## Human-review wiring (the remaining, money-moving step)

1. In `x402-thin-settlement-executor.ts`, replace the hard-coded request shape
   (currently `endpoint: input.selected.endpoint, method: "POST", body` at
   ~line 115-117) with the planner:

   ```ts
   const plan = planThinSettleRequest({
     method: input.selected.method,
     endpoint: input.selected.endpoint,
     body,
   });
   if (!plan.supported) throw new Error(plan.reason); // fail closed, no payment
   // request: { ..., endpoint: plan.endpoint, method: plan.method,
   //            body: plan.sendBody ? plan.body : undefined, ... }
   ```

2. Widen the adapt gate: have `isMethodSupportedByThinRunner`
   (`paid-method-honored-probe.ts`) delegate to `isThinRunnerSettleableMethod` so
   POST+GET candidates are no longer rejected up front — landed together with step 1.
3. Re-probe the newly-eligible candidates keyless (no payment) to confirm the catalog
   method matches a live 402 on that verb.
4. Re-evaluate the `api.onesource.io` blocklist entry with fresh evidence; removal
   remains a human decision.
