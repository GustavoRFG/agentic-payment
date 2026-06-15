# Phase 6.1 — Paid path hardening

Phase 6.1 hardens the settlement-first paid rich probe **before** any future human-authorized retry. No payment, wallet load, or live Zapper calls are performed in this phase.

## What Phase 6 revealed

Phase 6 run `phase6_20260615_035903` loaded the authorized wallet and attempted one x402 paid POST to Zapper. The paid retry returned **HTTP 402** with no settlement transaction hash. TrustScore creation was correctly blocked.

The offline diagnostic (`diag_20260615_042000`) classified the root cause as **INSUFFICIENT_EVIDENCE**: a payment-bearing request likely occurred, but saved artifacts did not capture the paid 402 rejection reason.

Cross-run review also showed:

- Some Phase 6 sibling runs returned **HTTP 402** after payment.
- Other sibling runs returned **HTTP 200** with seller body using the same exact-only buyer.
- Phase 6 had **multiple orchestrator invocations** within minutes against a single human authorization intended for **one** attempt.

## Why HTTP 402 after paid attempt is not enough evidence

`paid request HTTP 402` only proves the seller rejected the paid retry. It does not explain whether rejection was due to scheme, network, facilitator, balance, expiry, or transient seller behavior. Without sanitized paid 402 headers/body, root cause stays ambiguous.

## Why exact-vs-tempo is not currently proven root cause

Zapper unpaid responses advertise **both**:

- JSON `accepts[]` with `scheme: exact` on `eip155:8453`
- `WWW-Authenticate` advertising `method="tempo"`, `intent="charge"`

The TrustForge buyer registers **exact EVM only** (`@x402/fetch` + `@x402/evm@2.13.0`). Phase 3 and some Phase 6 runs succeeded with this buyer, so tempo/charge is **not** treated as the proven primary failure mode. Do **not** implement tempo/charge or switch provider based on Phase 6 alone.

## Paid 402 capture

When `performRichTxExplainerPaidRequest` receives HTTP 402 after a payment-bearing retry, it throws `PaidRequest402Error` with a sanitized capture written to:

- `rich_probe_run/paid_402_response_sanitized.json`
- `rich_probe_run/paid_402_response_sanitized.md`

Redacted header names include `PAYMENT-SIGNATURE`, `X-PAYMENT`, `Authorization`, `Cookie`, `Set-Cookie`, and raw `payment-required` values. Safe summaries of `WWW-Authenticate` (method/intent/expires/id) are retained without raw `request` payloads.

The capture answers:

- Did the server provide a rejection reason?
- Did new payment requirements appear?
- Do scheme/network/amount differ from the unpaid handshake?

## Single-shot authorization consumption

Phase 6.1 adds `authorization_consumption_ledger.json` beside the Phase 5 run:

```text
artifacts/runs/phase5-rich-provider-discovery/run_<id>/authorization_consumption_ledger.json
```

Before wallet load or paid execution, Phase 6 calls `reserveAuthorizationAttempt()` with a file lock. If `consumed_attempts >= max_payment_attempts`, the orchestrator stops with:

```text
BLOCKED_AUTHORIZATION_ALREADY_CONSUMED
```

No wallet load, no payment header generation, and no payment-bearing HTTP request occur on a blocked second invocation.

## `paymentBearingHttpRequestCount` definition

**Correct meaning:** count of outbound HTTP requests that include an x402 payment header (`PAYMENT-SIGNATURE` or `X-PAYMENT`).

**Incorrect meaning:** count of successful settlements or presence of `transaction_hash`.

Phase 6.1 fixes a bookkeeping bug where the catch path used `paymentTxHash ? 1 : 0`, masking payment attempts that failed before settlement.

## No retry without new authorization

Human authorization is **consumed** when reserved. Do not rerun `trustforge:phase6:paid-rich-probe` or `--execute-paid` without a new `human_payment_authorization.json` and explicit human decision.

Forbidden without new authorization:

- `npm run trustforge:rich-tx-explainer:paid`
- `npm run trustforge:phase6:paid-rich-probe`
- any `--execute-paid` flag

## Next human decision criteria

Before authorizing another paid attempt, verify:

1. Paid 402 capture artifacts exist for the prior failure (if applicable).
2. `authorization_consumption_ledger.json` reflects prior consumption.
3. `payment_bearing_http_request_count` in RESULT matches ledger/guard counts.
4. Settlement and semantic gates are understood.
5. A new `human_payment_authorization.json` is written with fresh `decided_at` and rationale.

## PAID invariants (Phase 6 / 6.1)

| ID | Rule |
|----|------|
| PAID-001 | `payment_bearing_http_request_count` reflects payment-header requests |
| PAID-002 | Count does not depend on `transaction_hash` |
| PAID-003 | Failed paid 402 after payment header captured as sanitized artifact |
| PAID-004 | Authorization not consumed beyond `max_payment_attempts` |
| PAID-005 | Second invocation blocked before wallet load |
| PAID-006 | No TrustScore if settlement evidence missing/fail |
| PAID-007 | No TrustScore if semantic evaluation missing/fail |
| PAID-008 | No secret-bearing headers in saved artifacts |

Run offline checks:

```powershell
npm run trustforge:phase6:invariants
```
