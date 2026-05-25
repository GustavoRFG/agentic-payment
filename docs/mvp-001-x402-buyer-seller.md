# MVP 001 — x402 Buyer/Seller for DeFi Guardian Paid Report

Date: 2026-05-25
Project: Agentic Payments Lab
Experiment: DeFi Guardian Paid API via x402
Network: Base Sepolia testnet only.

## 1. Why this MVP exists

We originally attempted to ride the Coinbase Agentic Wallet (AWAL) +
`payments-mcp` path. `payments-mcp` itself connects from Claude Code on
Windows (13 tools surfaced), but every wallet-level operation
(`get_wallet_address`, `npx awal status`, `npx awal auth login`) times out
on this environment. The full diagnosis lives in
[wallet-bridge-status.md](wallet-bridge-status.md).

**Decision:** Stop blocking on AWAL. Build a direct x402 buyer/seller
prototype that uses the open x402 packages instead.

This MVP is **not about real DeFi integration yet**. It is about proving
the paid-API mechanism end to end:

```
buyer-client
  → seller-api
  → HTTP 402 Payment Required
  → (later: signed testnet x402 payment)
  → DeFi Guardian *mock* report
```

## 2. Safety rules (non-negotiable)

- Base Sepolia testnet only — no mainnet.
- No real private keys. The buyer's `.env.example` ships with a placeholder
  that obviously cannot be a real key.
- No real funds moved. The buyer defaults to `--dry-run`.
- No Coinbase Agentic Wallet UI.
- No `make_http_request_with_x402`.
- No modification of unrelated projects (e.g. `D:\defi_guardian`).
- No secrets committed. Only `.env.example` is tracked. `.env` is in
  `.gitignore`.
- Every buyer request enforces an explicit `MAX_PAYMENT_USD` ceiling.
- Even when `--pay` is later passed, the buyer compares the server's
  required amount against the ceiling and bails out if it exceeds it.

## 3. Architecture

```
┌─────────────────────┐
│ buyer-client        │
│ TypeScript / Node   │
│ Base Sepolia only   │
│ defaults to dry-run │
└──────────┬──────────┘
           │
           │ POST /paid/defi-risk-report
           ▼
┌────────────────────────────────┐
│ seller-api                     │
│ Express + TypeScript           │
│ @x402/express middleware       │
│   on /paid/defi-risk-report    │
│ /health and /mock/...          │
│   are unprotected              │
└──────────┬─────────────────────┘
           │
           │ HTTP 402 with accepts[]
           ▼
┌────────────────────────────────┐
│ x402 payment flow              │
│ payment requirements only,     │
│ no signed payment until the    │
│ user explicitly enables --pay  │
└──────────┬─────────────────────┘
           │ (later)
           ▼
┌────────────────────────────────┐
│ DeFi Guardian *mock* report    │
│ no real DeFi integration yet   │
└────────────────────────────────┘
```

## 4. Packages used (verified against current docs)

- Seller (`seller-api/package.json`):
  - `@x402/express`, `@x402/evm`, `@x402/core`
  - `express`, `dotenv`
  - `tsx`, `typescript`, `@types/express`, `@types/node` (dev)
- Buyer (`buyer-client/package.json`):
  - `@x402/fetch`, `@x402/evm`
  - `viem`, `dotenv`
  - `tsx`, `typescript`, `@types/node` (dev)

CAIP-2 network ID for Base Sepolia: `eip155:84532`.
Testnet facilitator: `https://x402.org/facilitator` (no auth required).
Price format expected by `@x402/express`: dollar-prefixed string, e.g.
`"$0.001"`. Omitting the `$` triggers validation errors.

## 5. Commands

Seller:

```powershell
cd D:\agentic-payments-lab\seller-api
npm install
npm run build      # tsc --noEmit
npm run dev        # tsx src/server.ts
```

Smoke tests:

```powershell
curl.exe http://localhost:4021/health
curl.exe -X POST http://localhost:4021/mock/defi-risk-report `
  -H "Content-Type: application/json" `
  -d "{\"wallet\":\"0x0000000000000000000000000000000000000000\",\"position\":{\"protocol\":\"pancakeswap\",\"chain\":\"bsc\",\"tokenId\":\"demo-position-001\"}}"
curl.exe -i -X POST http://localhost:4021/paid/defi-risk-report `
  -H "Content-Type: application/json" `
  -d "{\"wallet\":\"0x0000000000000000000000000000000000000000\",\"position\":{\"protocol\":\"pancakeswap\",\"chain\":\"bsc\",\"tokenId\":\"demo-position-001\"}}"
# expect HTTP/1.1 402 Payment Required
```

Buyer dry-run:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm install
npm run build
npm run dev -- --dry-run
```

## 6. No real payment will be attempted in this cycle

`buyer-client` defaults to dry-run. In dry-run mode it:

- calls `/paid/defi-risk-report` with plain `fetch`,
- expects HTTP 402,
- prints the `accepts[]` payment requirements,
- compares the required atomic amount against `MAX_PAYMENT_USD`,
- exits without signing anything.

A future cycle will:

1. Create a fresh Base Sepolia testnet wallet.
2. Obtain testnet ETH and testnet USDC.
3. Set `BUYER_PRIVATE_KEY` for that fresh wallet only.
4. Run `npm run dev -- --pay` for one controlled signed testnet payment.
5. Only then consider connecting to the real DeFi Guardian engine in
   `D:\defi_guardian`.
