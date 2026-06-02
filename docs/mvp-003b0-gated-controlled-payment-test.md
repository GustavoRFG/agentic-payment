# MVP 003B.0 - Gated Controlled-Payment Integration Test

MVP 003B.0 adds one opt-in Vitest integration test for the controlled Base
Sepolia x402 payment path.

The test is skipped by default. A normal run of:

```powershell
npm.cmd test
```

does not attempt payment, does not sign, and does not broadcast anything.

## Opt-In Gate

The test only runs when both environment variables are present:

```powershell
$env:ENABLE_CONTROLLED_PAYMENT="1"
$env:CONTROLLED_PAYMENT_CONFIRMATION="ONE_BASE_SEPOLIA_PAYMENT"
```

The exact gated command for the next approved step is:

```powershell
npm.cmd test -- --run tests/integration/controlled-payment.test.ts
```

Do not run this without explicit user approval.

## Safety Invariants

The buyer, seller safety config, and controlled integration test import the
shared payment invariants from `shared/payment-safety.ts`:

```text
network = eip155:84532
asset = USDC
amountAtomic = 1000
amountUsd = 0.001
maxAttempts = 1
```

The test asserts the seller's HTTP 402 payment requirements match those exact
values before the buyer path is allowed to run.

There is no mainnet fallback, no retry loop, and no amount escalation.

## Single Paid Invocation Hardening

MVP 003B.0.1 makes the one-payment boundary explicit inside the buyer before
the controlled payment is approved.

The integration wrapper invokes the buyer payment process exactly once. The
buyer also has its own paid invocation guard and calls it immediately before
the single `fetchWithPayment(...)` invocation in the `--pay` branch.

`maxAttempts` is centralized in `shared/payment-safety.ts` and remains fixed at
`1`. A second paid invocation in the same guarded flow is refused with
`refusing more than one controlled payment invocation`.

No retry loop exists in the buyer. The x402 fetch wrapper performs the protocol
request sequence for one invocation, but the buyer does not add another loop,
fallback, or amount escalation around it.

The dry-run path does not create or consume a paid invocation guard. It still
performs only the unpaid HTTP 402 requirements check and exits without signing.

No payment was executed during MVP 003B.0.1.

## One Payment-Bearing HTTP Request Guard

MVP 003B.0.2 hardens the boundary one layer deeper. The installed `@x402/fetch`
wrapper performs its own internal HTTP protocol sequence for a single buyer
invocation:

```text
initial unpaid request → HTTP 402 → paid follow-up request
```

The follow-up request carries the payment signature in one outbound header,
which (for the installed x402 version) is `PAYMENT-SIGNATURE` for protocol v2
(the current default) or `X-PAYMENT` for protocol v1. The wrapper also contains
an internal branch that could, in principle, emit a second payment-bearing
request. To make that impossible:

- the buyer calls `fetchWithPayment` once (boundary 2, the paid invocation guard);
- the raw `fetch` passed into `@x402/fetch` is wrapped by a guarded fetch
  (`createPaymentBearingRequestGuard()`), so every outbound request is inspected;
- the initial unpaid request carries no payment header and is allowed;
- exactly one payment-bearing follow-up request is allowed;
- a second payment-bearing HTTP request is refused with
  `refusing more than one payment-bearing HTTP request`;
- the guard inspects header *names* only — payment header values (signatures,
  authorization payloads) are never read or logged; only a safe count
  (`payment-bearing HTTP requests: 1`) is printed after a successful response;
- `maxPaymentBearingRequests` defaults to the centralized `MAX_PAYMENT_ATTEMPTS`
  (`1`) in `shared/payment-safety.ts`.

The three one-payment boundaries are distinct and all fixed at `1`:

```text
wrapper process invocation max     = 1
buyer fetchWithPayment invocation  = 1
payment-bearing HTTP request max   = 1
```

No payment was executed in MVP 003B.0.2.

## Workflow

When explicitly enabled, the test:

1. Confirms the local sanitized snapshot exists.
2. Validates snapshot v1.
3. Starts the seller through the shared seller harness in `adapter-real-file`
   mode.
4. Selects one active tokenId from the sanitized snapshot.
5. Confirms the public endpoint resolves `adapter-real-file` with
   `fallbackUsed=false`.
6. Confirms the protected endpoint returns HTTP 402 when unpaid.
7. Verifies network, asset, exact amount, and `maxAttempts=1`.
8. Runs the buyer payment path once.
9. Asserts the paid report returns successfully.
10. Stops the seller in `finally`.

The test prints only sanitized metadata: snapshot timestamp, selected tokenId,
adapter mode, fallback flag, risk score, recommendation, payment requirement
summary, and payment attempt count.

It must not print private keys, raw wallet addresses, `.env` contents, payment
signatures, authorization headers, or raw payment payloads.

## Deprecated Fallback Script

`tools/run-paid-real-local-controlled-payment.ts` is preserved as a deprecated
fallback while this integration test remains unproven against one explicitly
approved payment. It should not be deleted in MVP 003B.0.

## MVP 003B.0 Result

No payment is executed during MVP 003B.0. This milestone only adds the gated
test and documents the approval boundary.
