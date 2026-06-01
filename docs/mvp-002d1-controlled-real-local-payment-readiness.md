# MVP 002D.1A - Controlled Real-Local Payment Readiness Gate

## Purpose

Prepare, but do not execute, one controlled x402 payment for an actual
sanitized local DeFi Guardian report. The payment gate is deliberately narrow:
one Base Sepolia testnet payment, USDC only, exactly `1000` atomic units
(`0.001 USDC` / `$0.001`), no retry, no fallback, no mainnet.

## Safety branch and tag

- Safety tag: `mvp-002d0-dry-run-ready`
- Branch: `mvp-002d1-controlled-real-local-payment`

The tag points at MVP 002D.0 dry-run readiness before this controlled-payment
gate work.

## Actual local snapshot source

The source remains the existing read-only DeFi Guardian exporter:

```powershell
npm.cmd run snapshot:refresh:local
```

Current readiness validation used the gitignored snapshot at
`runtime/defi-guardian-snapshots/latest.json`.

Observed result:

- `RESULT: AGENTIC_SNAPSHOT_EXPORTED`
- `RESULT: SNAPSHOT_VALID`
- Snapshot version: `defi-guardian-snapshot-v1`
- Positions: `4`
- Secrets detected: `No`
- Raw wallet addresses emitted: `No`
- RPC called: `No`
- MongoDB writes performed: `No`
- Transactions attempted: `No`

## Dry-run payment boundary result

The existing paid real-local dry-run was rerun:

```powershell
npm.cmd run demo:paid-real-local-dry-run
```

Observed result:

- `RESULT: PAID_REAL_LOCAL_DRY_RUN_SUCCEEDED`
- Protected endpoint unpaid response: `HTTP 402`
- Buyer dry-run: `OK`
- x402 payment attempted: `No`
- Mainnet used: `No`
- USDT payment rail used: `No`
- Secrets touched: `No`
- Raw wallet address printed by that dry-run: `No`
- MongoDB writes performed: `No`
- RPC called: `No`

## Wallet readiness result

The existing safe read-only balance checker was run:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run wallet:check
```

Observed readiness:

- Network: `eip155:84532`
- Asset target: `USDC Base Sepolia`
- Required USDC: `0.001 / 1000 atomic units`
- ETH status: `pass`
- USDC status: `pass`
- Payment execution: `not performed by this script`

The wallet checker may print the public buyer address locally. This document
does not repeat it.

## Hard payment invariants

The controlled script hard-codes and validates:

- `network = eip155:84532`
- `asset = USDC`
- `amountAtomic = 1000`
- `amountUsd = 0.001`
- `maxAttempts = 1`

It rejects:

- missing or incorrect confirmation token;
- mainnet network;
- non-USDC asset;
- amount other than `1000` atomic units;
- amount greater than `$0.001`;
- missing local snapshot;
- invalid local snapshot;
- missing ETH gas balance;
- missing USDC balance;
- port `4021` already in use.

The script refreshes and validates the sanitized local snapshot, selects one
active tokenId, starts `seller-api` in `adapter-real-file` mode, validates the
public report first, validates unpaid protected `HTTP 402`, then invokes the
buyer payment path exactly once. Seller shutdown runs in `finally`.

## Environment isolation hardening

MVP 002D.1A.1 isolates child-process environments before any explicit payment
approval:

- the seller subprocess does not inherit buyer payment secrets from the parent
  shell;
- the snapshot refresh subprocess does not inherit payment secrets;
- wallet-check and buyer-payment subprocesses omit inherited payment secrets and
  allow `buyer-client` to load its own local testnet-only configuration inside
  its own process;
- the unauthorized self-test returns `PAYMENT_NOT_AUTHORIZED`;
- no payment was executed during hardening.

## Confirmation token

The exact token required to run the controlled payment is:

```text
ONE_BASE_SEPOLIA_PAYMENT
```

Command shape:

```powershell
npm.cmd run demo:paid-real-local-controlled -- --confirm ONE_BASE_SEPOLIA_PAYMENT
```

## 002D.1A execution status

The controlled payment script was added but **was not executed** in MVP 002D.1A.
No payment was attempted, no signature was produced, and no transaction was
broadcast.

## Next manual authorization step

Wait for explicit user approval before running:

```powershell
npm.cmd run demo:paid-real-local-controlled -- --confirm ONE_BASE_SEPOLIA_PAYMENT
```
