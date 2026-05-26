# MVP 001B.0 - Controlled Base Sepolia Payment Readiness

MVP 001B.0 prepares the environment. It does not execute payment.

MVP 001B.1 will execute one controlled Base Sepolia payment only after
explicit user approval.

## Current MVP 001 status

MVP 001 is committed at:

```text
4726d8c532d9c34144ec6b717f1d5abc0e0a82e1
feat: scaffold x402 buyer seller MVP
```

The project already has:

- `seller-api` with `/health`, `/mock/defi-risk-report`, and
  `/paid/defi-risk-report`.
- `buyer-client` with default dry-run behavior.
- HTTP 402 `Payment Required` handling.
- `PAYMENT-REQUIRED` header decoding.
- Placeholder key refusal before payment execution.

No real payment has been attempted.

## Why real USDT is excluded

USDT is explicitly out of scope for this milestone because the next payment
must be small, reversible in operational impact, and testnet-only. Real USDT
would introduce mainnet funds, custody risk, and irreversible settlement risk.

MVP 001B uses USDC on Base Sepolia testnet only.

## Why Base Sepolia USDC is the next step

Base Sepolia is the safest next target because:

- it is testnet-only;
- the existing seller and buyer are already locked to `eip155:84532`;
- x402 can advertise a small USDC payment requirement;
- the intended amount is `0.001 USDC`, equivalent to `1000` atomic units for a
  6-decimal USDC asset;
- failures do not risk mainnet funds.

## MVP 001B.0 vs MVP 001B.1

MVP 001B.0:

- documents the controlled payment plan;
- validates Base Sepolia-only configuration;
- validates that no USDT/mainnet path is enabled;
- validates dry-run behavior;
- validates placeholder or missing key safety;
- does not sign;
- does not pay.

MVP 001B.1:

- may execute exactly one Base Sepolia x402 payment;
- requires explicit user approval;
- requires a fresh testnet-only wallet;
- requires Base Sepolia ETH for gas and Base Sepolia USDC for payment;
- must still use the same low ceiling of `MAX_PAYMENT_USD=0.001`.

## Required testnet wallet setup

Before MVP 001B.1, create a fresh wallet only for this lab.

Requirements:

- never used on mainnet;
- no real funds;
- funded only on Base Sepolia;
- private key stored only in local `.env`, never committed;
- receiver address controlled by the operator.

Do not reuse any production wallet or any wallet that has held mainnet value.

## Required testnet assets

For the future MVP 001B.1 payment:

- Base Sepolia ETH for gas;
- Base Sepolia USDC for the x402 payment;
- amount target: `0.001 USDC`;
- atomic target: `1000`.

## Safety checklist before payment

Before any future payment attempt:

- `X402_NETWORK=eip155:84532`;
- `MAX_PAYMENT_USD=0.001`;
- seller receiver is a Base Sepolia testnet address;
- buyer wallet is a fresh testnet-only wallet;
- no `.env` file is committed;
- no mainnet network is configured;
- no USDT asset path is configured;
- dry-run decodes the payment requirements successfully;
- `npm run dev -- --pay` refuses missing or placeholder key;
- user explicitly approves one controlled testnet payment.

## Readiness commands

From the repository root:

```powershell
npm run buyer:payment-check
```

From `buyer-client`:

```powershell
npm.cmd run payment:check
npm.cmd run dev -- --dry-run
```

Seller build:

```powershell
cd D:\agentic-payments-lab\seller-api
npm.cmd run build
```

Buyer build:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run build
```

## Commands still forbidden in MVP 001B.0

Do not run a real payment in this phase.

Forbidden:

```powershell
npm.cmd run dev -- --pay
```

The only acceptable `--pay` use in MVP 001B.0 is a safety check where the
private key is missing or placeholder and the buyer refuses before signing or
payment.

Also forbidden:

- mainnet configuration;
- USDT payment paths;
- real private keys;
- real funds;
- Coinbase AWAL / Agentic Wallet UI work;
- `make_http_request_with_x402`.

## Criteria to allow future MVP 001B.1

MVP 001B.1 may start only if all are true:

- MVP 001B.0 is committed;
- `npm.cmd run payment:check` exits 0;
- seller and buyer builds pass;
- seller `/health` works locally;
- `/paid/defi-risk-report` returns HTTP 402 without payment;
- buyer `--dry-run` decodes payment requirements;
- `--pay` with missing or placeholder key refuses before signing;
- a fresh testnet-only wallet is prepared;
- Base Sepolia ETH and Base Sepolia USDC are available;
- the user explicitly approves one controlled Base Sepolia payment.

## Roadmap

```text
MVP 001A   Scaffold x402 buyer/seller
MVP 001B.0 Payment readiness and safety checks
MVP 001B.1 One controlled Base Sepolia payment
MVP 001C   Attach seller to DeFi Guardian mock adapter
MVP 002    Connect real DeFi Guardian engine
MVP 003    Agent/MCP interface
MVP 004    Dashboard
```
