# MVP 001B.1 - Controlled Base Sepolia Payment Result

Date: 2026-05-26

Branch: `mvp-001b1-controlled-payment`

Commit before test: `9dbb5532997147bd209c55d7efed7de0ce3a33b3`

## Scope

This phase was intended to execute one controlled x402 payment on Base Sepolia
only after readiness checks, wallet configuration, and testnet funding were
confirmed.

No payment was executed in this run.

## Local wallet setup update

Fresh testnet wallet generated for Base Sepolia only.

Local `.env` files created but not committed:

- `buyer-client/.env`
- `seller-api/.env`

Buyer address: `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`

Seller receiver address: `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`

Wallet funding still required:

- Base Sepolia ETH for gas is missing.
- Base Sepolia USDC is missing.

## Network, asset, and amount

- Network: Base Sepolia
- CAIP-2: `eip155:84532`
- Asset: USDC on Base Sepolia
- Amount: `0.001 USDC`
- Atomic amount: `1000`
- Paid endpoint: `POST http://localhost:4021/paid/defi-risk-report`

## Wallet readiness result

`buyer-client/.env` was not present locally, so no fresh testnet-only
`BUYER_PRIVATE_KEY` was configured for this run.

Because the buyer key was absent:

- buyer address could not be derived;
- Base Sepolia ETH balance could not be checked;
- Base Sepolia USDC balance could not be checked;
- payment execution was blocked before any signing path.

The repository now includes a read-only wallet preflight command for the next
attempt:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run wallet:check
```

The script derives the buyer address, checks Base Sepolia ETH, checks Base
Sepolia USDC, and never prints the private key.

## Dry-run result

Not executed in this blocked run because the required local `.env` files were
absent. The previous MVP 001B.0 validation already proved the dry-run path with
the local seller and HTTP 402 requirements.

Before a future payment attempt, rerun:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run payment:check
npm.cmd run wallet:check
npm.cmd run dev -- --dry-run
```

## Payment execution result

Blocked. No payment was attempted.

Reason:

```text
buyer-client/.env missing; no fresh testnet-only BUYER_PRIVATE_KEY configured.
```

## Paid report result

No paid report was returned in this run because payment execution was blocked.

## Safety confirmations

- No mainnet funds were used.
- No USDT was used.
- No private key was printed.
- No `.env` file was committed.
- No Coinbase AWAL / Agentic Wallet UI path was used.
- `make_http_request_with_x402` was not used.

## Required next setup

Create or provide a fresh testnet-only wallet that has never held mainnet
funds, then fund it with:

- Base Sepolia ETH for gas;
- at least `0.001` Base Sepolia USDC for payment.

Then create local ignored files:

- `seller-api/.env`
- `buyer-client/.env`

Do not commit those files.
