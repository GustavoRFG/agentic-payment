# TrustForge Phase 6.2B — Facilitator Receipt and Bounded Reconciliation

## Installed x402 behavior (observed)

| Package | Version |
|---|---|
| `@x402/fetch` | 2.13.0 |
| `@x402/evm` | 2.13.0 |
| `@x402/core` | 2.13.0 (transitive) |

### Response receipt header

- Primary: `payment-response` (case-insensitive via `Headers.get`)
- Alias: `x-payment-response`
- Precedence: `payment-response` first, then `x-payment-response`
- Wrapped fetch exposes `PAYMENT-RESPONSE,X-PAYMENT-RESPONSE` in access-control headers

### Encoding

- Base64 JSON payload (`decodePaymentResponseHeader` from `@x402/core/http`)
- Direct JSON in header tolerated for offline fixtures only

### Transaction hash field

- Canonical SDK field: `transaction` (`SettleResponse`)
- Compatibility aliases supported in TrustForge parser: `transactionHash`, `transaction_hash`, `txHash`, `tx_hash`, `settlementTxHash`, `settlement_tx_hash`, nested `transaction.hash`

## Sanitization policy

Persisted artifact: `facilitator_receipt_<attempt_id>.json`

Allowed: public tx hash, network, payer, payTo, asset, amount, facilitator URL/id, timestamps, parse status, error class.

Forbidden: request payment headers, EIP-3009 signatures, private keys, cookies, API keys, raw secret-bearing payloads.

## Binding states

| Independent match | Receipt | Hash | Status |
|---:|---|---|---|
| 0 | any | any | `settlement_not_found` |
| >1 | any | any | `ambiguous_match` |
| 1 | missing | none | `facilitator_receipt_missing` |
| 1 | malformed | none | `facilitator_receipt_malformed` |
| 1 | parsed | missing | `facilitator_hash_missing` |
| 1 | parsed | different | `hash_mismatch` |
| 1 | parsed | equal | `confirmed` |

`PASS_SETTLED` requires `confirmed` plus balance identity pass and strict no-mainnet.

## RPC timeout policy

Python reconciler CLI:

```text
--rpc-request-timeout-seconds 20
--rpc-max-retries 2
--max-total-runtime-seconds 180
```

TypeScript classify spawns Python with matching args and enforces child-process deadline via `spawnSync` timeout.

Timeout result: `RECONCILIATION_RPC_TIMEOUT`, `safe_to_use_for_payment_verification: false`.

## Offline ledger reuse

Flag: `--reuse-existing-ledger`

Validates before reuse:

- schema `trustforge_onchain_settlement_ledger` v0.2.x
- network / chain_id / buyer wallet / USDC contract
- scanned block metadata present
- optional manifest SHA-256 when present

Mismatch: `REUSE_LEDGER_IDENTITY_MISMATCH`

## Human live Sepolia regression (not agent-executed)

1. Fresh run bootstrap → `READY_FOR_HUMAN_AUTH`
2. New `human_payment_authorization.json` (never reuse consumed auth)
3. Preflight without key
4. Human loads Sepolia key only; verify public address
5. Exactly one `run-trustforge-sepolia-settlement-probe.ts`
6. Classify with bounded RPC flags (or validated ledger reuse on RPC failure)
7. Require `binding_status: confirmed` and facilitator hash cross-check

Strict no-mainnet remains enforced. Milestone `PHASE62_SHARED_EXECUTOR_PROVEN` only after successful human regression with parsed receipt.

## Agent readiness result

When code/tests/docs are complete without payment:

```text
RESULT: PHASE62B_READY_FOR_HUMAN_SEPOLIA_REGRESSION
```
