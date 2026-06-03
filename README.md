# Agentic Payments Lab

> An experimental commerce layer for AI agents.

A minimal, working demonstration of machine-to-machine payments:
an AI agent autonomously discovers a paid API, pays **$0.001 USDC**
on Base Sepolia, and receives a real Claude-powered text analysis
no account, no subscription, no OAuth.

## What this proves

The full economic cycle works end-to-end:

```
agent sends text
   POST /paid/analyze-text
   HTTP 402 with payment conditions
   agent verifies price fits budget
   agent signs and pays 0.001 USDC on Base Sepolia
   seller validates via Coinbase x402 facilitator
   seller calls Claude Haiku
   agent receives JSON: summary + sentiment + entities
```

No prior relationship between buyer and seller required.
The payment is the credential.

## Stack

| Layer | Technology |
|---|---|
| Payment protocol | [x402](https://x402.org) |
| Payment network | Base Sepolia (testnet) |
| Payment asset | USDC |
| Seller framework | Express + `@x402/express` |
| Buyer client | `@x402/fetch` + viem |
| AI analysis | Claude Haiku (`claude-haiku-4-5`) via Anthropic API |
| Wallet | Coinbase Developer Platform (CDP) |
| Tests | Vitest 45 unit + integration tests |

## Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `GET /health` | none | Liveness check |
| `POST /mock/defi-risk-report` | none | DeFi risk report (mock, no payment) |
| `POST /paid/defi-risk-report` | x402 USDC | DeFi risk report (paid demo) |
| `POST /paid/analyze-text` | x402 USDC | Text analysis via Claude |

## Quick start

### Requirements

- Node.js 20+
- A funded Base Sepolia wallet (ETH for gas + USDC testnet)
- Anthropic API key
- Coinbase CDP credentials

### Seller

```bash
cd seller-api
cp .env.example .env   # add ANTHROPIC_API_KEY and CDP credentials
npm install
npm run dev
# listening on http://localhost:4021
```

### Buyer dry-run (no payment)

```bash
cd buyer-client
cp .env.example .env   # add BUYER_PRIVATE_KEY
npm install
npm run dev -- --dry-run
# receives HTTP 402, prints payment requirements, exits without paying
```

### Buyer pay

```bash
npm run dev -- --pay
# pays 0.001 USDC, receives Claude analysis
```

## Example response

```json
{
  "requestId": "73da8c20-...",
  "mode": "full",
  "summary": "Anthropic released Claude 4 in 2025 with improved speed and reasoning capabilities.",
  "sentiment": {
    "label": "positive",
    "confidence": "high",
    "rationale": "The text uses positive language and highlights improvements."
  },
  "entities": [
    { "text": "Anthropic", "type": "organization" },
    { "text": "Claude 4", "type": "other" },
    { "text": "2025", "type": "date" }
  ],
  "tokensUsed": { "input": 169, "output": 181 },
  "model": "claude-haiku-4-5-20251001"
}
```

## Safety design

- Locked to Base Sepolia: no mainnet fallback
- `MAX_PAYMENT_ATTEMPTS = 1`: no retry, no escalation
- Payment-bearing HTTP requests capped at 1 per invocation
- Controlled payment integration test skipped by default
- All safety invariants live in `shared/payment-safety.ts` and `seller-api/src/config/safety.ts`
- No secrets committed: `.env` files are gitignored

## Project structure

```
agentic-payments-lab/
 seller-api/          # x402-gated Express server
    src/
        adapters/
           text-analysis/   # Claude Haiku adapter
           defi-guardian/   # DeFi risk adapter (demo)
        config/safety.ts    # payment invariants
 buyer-client/        # autonomous payment client
 shared/              # shared constants
    payment-safety.ts
 tests/               # Vitest unit + integration suite
    unit/
    integration/
 tools/               # demo scripts and seller harness
     _lib/seller-harness.ts
```

## Results

Two real x402 payments confirmed on Base Sepolia testnet.
Audit log: `logs/seller-events.jsonl`, `logs/buyer-events.jsonl`.

Built in 2 days. Tested. No errors.
