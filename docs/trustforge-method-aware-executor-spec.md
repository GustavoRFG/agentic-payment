# SPEC: method-aware thin settlement executor

Status: **A.2 corrective revision implemented + tested (no-payment).**
The pure request-shaping logic (verb selection, GET query placement, safe-verb
gating) now lives behind the import-free
`tools/trustforge/thin-settlement-method-contract.ts`. The executor planner is a
compatibility facade over that neutral contract; the A.1 and quote-stability
keyless probes consume the contract directly. No key, wallet, live network request,
payment authorization artifact, or settlement was used.

## Problem

The thin settlement executor (`tools/trustforge/x402-thin-settlement-executor.ts`)
previously sent the paid settlement request with a hard-coded `POST`. The bazaar
catalog, however, declares a `method`
per candidate (`TargetCandidate.method`: GET | POST | PUT | PATCH | DELETE | HEAD).
When a candidate's catalog method is GET (or any non-POST), settle POSTs to a route
that only serves GET → HTTP 405. This is the root cause of the observed 405s
(`api.onesource.io`, runs `run_20260723_153238` / `run_20260724_005838`): our own
verb mismatch, not a seller defect (see the blocklist entry's `reinterpretation`).

Today ~19 of the 82 catalog candidates are POST-settleable; the remaining ~63 are
excluded purely because settle cannot speak their method. Supporting every catalog
verb could eventually open up to **63/82** additional candidates; this reviewed
slice enables only GET alongside POST.

## Reviewed design

1. Thread the selected candidate's `method` into the paid request instead of the
   `POST` constant. Concretely, `executeThinX402Settlement` reads
   `selected.method` (already carried on `DiscoveredSelectedCandidate`) and issues
   the paid request with that verb, defaulting to POST when absent.
2. Body/URL handling for the enabled verbs: POST carries the JSON body; GET carries
   no body and moves required flat parameters to the query string.
3. Keep A.1's supported-method gate aligned with the planner.
   `isMethodSupportedByThinRunner` widens from "POST only" to "POST + GET".
   Both keyless 402 reads use the candidate's planned method and request shape.
4. Idempotency/safety: only verbs that the x402 settlement semantics define as safe
   to retry under a single human authorization should be enabled at first
   (POST + GET). PUT/PATCH/DELETE stay gated until reviewed per-method.

## Why this is gated behind human review

- It changes money-moving behavior in the executor, which is deliberately treated
  as a review boundary (every other task in this series keeps the executor
  untouched). A wrong verb or body placement could submit a malformed paid request.
- It widens the settleable surface 4× (19 → 82), so the blast radius of a bug grows
  with it.

## Neutral contract and import graph

`thin-settlement-method-contract.ts` owns:
- `planThinSettleRequest({ method, endpoint, body })` → `{ supported, method, endpoint, body, sendBody }`
  (POST default; GET moves params to the query and carries no body; PUT/PATCH/DELETE/HEAD → `supported: false`).
- `isThinRunnerSettleableMethod` / `THIN_RUNNER_SETTLEABLE_METHODS` (`["POST","GET"]`) — the single
  source of truth for the enabled verbs.
- `REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER` and method normalization.

The dependency graph is acyclic:

```text
thin-settlement-request-plan ─┐
paid-method-honored-probe ────┼─> thin-settlement-method-contract
quote-stability-probe ────────┘
```

The neutral contract imports none of those consumers. The planner and probe do
not import each other.

## Human-review wiring completed

1. `x402-thin-settlement-executor.ts` calls `planThinSettleRequest` and refuses
   `supported: false` before the shared executor can run.
2. POST preserves the existing endpoint and body. GET moves flat body parameters
   to the query string and passes no body to the shared executor.
3. `isMethodSupportedByThinRunner` delegates to
   `isThinRunnerSettleableMethod`: POST + GET pass A.1, while
   PUT/PATCH/DELETE/HEAD remain blocked.
4. The method and quote-stability probes both use the planned candidate method.
   A GET-only candidate is probed twice with GET and can reach selection.
5. Unit tests mock the shared executor and freshness preflight; they load no key,
   contact no live endpoint, create no payment header, and execute no payment.

Before any real settle, the adapter must complete both keyless GET probes with
fresh HTTP 402 responses. An independent manual check can use:

```powershell
curl.exe --silent --show-error --include --request GET --header "Accept: application/json" "<GET_ENDPOINT_WITH_REQUIRED_QUERY_PARAMS>"
```

Do not add `PAYMENT-SIGNATURE`, `X-PAYMENT`, or another payment-bearing header.
Re-evaluating any provider blocklist entry still requires fresh evidence and a
separate human decision.
