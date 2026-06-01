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

The integration test imports the existing invariants from
`seller-api/src/config/safety.ts`:

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
