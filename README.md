# Agentic Payments Lab

> An experimental commerce layer for AI agents.

A minimal, working demonstration of machine-to-machine payments:
an AI agent autonomously discovers a paid API, pays USDC on Base
Sepolia by default or Base mainnet by explicit opt-in, and receives a
real Claude-powered text/code service response with no account, no
subscription, no OAuth.

## What this proves

The full economic cycle works end-to-end:

```
agent sends text
   POST /paid/analyze-text
   HTTP 402 with payment conditions
   agent verifies price fits budget
   agent signs and pays USDC on Base Sepolia or opt-in Base mainnet
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
| Payment network | Base Sepolia (testnet) by default; Base mainnet opt-in |
| Payment asset | USDC |
| Seller framework | Express + `@x402/express` |
| Buyer client | `@x402/fetch` + viem |
| AI analysis | Claude Haiku (`claude-haiku-4-5`) via Anthropic API |
| Wallet | Coinbase Developer Platform (CDP) |
| Tests | Vitest unit + integration tests |

## Endpoints

| Endpoint | Auth | Price | Description |
|---|---|---:|---|
| `GET /health` | none | - | Liveness check |
| `POST /mock/defi-risk-report` | none | - | DeFi risk report (mock, no payment) |
| `POST /paid/analyze-text` | x402 USDC | $0.001 | Text analysis via Claude Haiku |
| `POST /paid/analyze-code` | x402 USDC | $0.002 | Code bug/improvement analysis via Claude Haiku |
| `POST /paid/summarize` | x402 USDC | $0.001 | Text summary points via Claude Haiku |
| `POST /paid/extract-data` | x402 USDC | $0.002 | Field extraction via Claude Haiku |
| `POST /paid/translate` | x402 USDC | $0.001 | Translation and source-language detection via Claude Haiku |

The legacy `POST /paid/defi-risk-report` endpoint remains available for
older demos, but it is not part of the published text/code service catalog.

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

### TrustForge external GET dry-run

The TrustForge MVP-T0A adapter is a narrow external preflight surface for one
allowlisted x402 seller endpoint:

```bash
npm run trustforge:probe:external:dry-run -- --policy onesource_api_chain_id_base_mainnet_v1
```

Safety invariants:

- supports only `GET https://api.onesource.io/api/chain/chain-id?network=ethereum`;
- requires Base mainnet CAIP-2 `eip155:8453` and USDC;
- enforces `0.005 USDC` max per call, `0.005 USDC` max total, and one payment attempt;
- disables redirects, retries, fallback, batch, loops, and scheduler behavior;
- performs only an unpaid `402` handshake inspection and writes run-scoped evidence under `D:\trustforge-mvp-t0a-adapter`;
- never loads a wallet, signs, sends a payment header, or executes settlement.

The adapter exists only to unblock a separately reviewed future paid smoke.
Any new external target must be added as an explicit code-reviewed policy.

### TrustForge external paid readiness

The T0B readiness surface prepares a future one-shot paid probe without running
one now:

```bash
npm run trustforge:probe:external:paid-readiness -- --policy onesource_api_chain_id_base_mainnet_v1 --readiness-only
```

Readiness mode performs a fresh unpaid `402` handshake, validates the live
quote/network/asset against the exact policy, confirms paid execution is not
armed, writes scratch evidence outside the repo, and exits before ground truth,
wallet load, signing, payment headers, or settlement.

The future paid path is intentionally harder to arm. It requires all of:

- `--execute-paid`;
- `--policy onesource_api_chain_id_base_mainnet_v1`;
- `--run-id <non-empty>`;
- `TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED=YES_I_AUTHORIZE_ONE_PAYMENT`;
- fresh unpaid handshake in the same invocation;
- ground-truth `eth_chainId == 0x1` before wallet load;
- one payment attempt maximum, with redirects, retries, fallback, batch, loops,
  and scheduler behavior disabled.

The current readiness command does not load a wallet and does not expose an
automatic payment script. The real paid smoke remains a separate reviewed task.

## MCP gateway

A local MCP gateway exposes the paid text-analysis endpoint to MCP-compatible
agents:

- `inspect_analyze_text_price` - inspect x402 requirements without paying
- `analyze_text_paid` - pay once and receive Claude-powered analysis

MVP 007A defaults to Base Sepolia and blocks MCP mainnet payments.

## Networks

By default the server runs on Base Sepolia (testnet) for safe development.
Set `X402_USE_MAINNET=1` in the seller `.env` to switch to Base mainnet
with real USDC. Mainnet uses the CDP production facilitator.

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

- Defaults to Base Sepolia: Base mainnet requires `X402_USE_MAINNET=1`
- Ethereum mainnet (`eip155:1`) and other networks remain blocked
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

- Two real x402 payments confirmed on Base Sepolia testnet.
- One real x402 payment confirmed on Base mainnet.
- Mainnet settlement: `0.001 USDC` transferred from a buyer wallet to a distinct seller wallet.
- The protected `/paid/analyze-text` endpoint returned a real Claude Haiku response only after successful settlement.
- Public on-chain proof: [`docs/mvp-006-mainnet-payment-proof.md`](docs/mvp-006-mainnet-payment-proof.md)

Audit logs are stored locally in:

- `logs/seller-events.jsonl`
- `logs/buyer-events.jsonl`

Built as an experimental agent-commerce lab with testnet and mainnet validation.
