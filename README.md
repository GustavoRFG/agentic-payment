# Agentic Payments Lab

An experimental commerce layer for AI agents.

A minimal, working demonstration of machine-to-machine payments:
an AI agent autonomously discovers a paid API, pays $0.001 USDC
on Base Sepolia, and receives a real Claude-powered text analysis
no account, no subscription, no OAuth.

## Endpoints

| Endpoint | Auth | Description |
|---|---|---|
| `POST /paid/analyze-text` | x402 USDC | Text analysis via Claude (summary, sentiment, entities) |
| `POST /mock/defi-risk-report` | none | DeFi risk report (mock adapter, demo) |
| `POST /paid/defi-risk-report` | x402 USDC | DeFi risk report (paid, demo) |

## Quick demo

```bash
# Start seller
cd seller-api && npm run dev

# Dry-run (no payment)
cd buyer-client && npm run dev -- --dry-run

# Pay and receive analysis
cd buyer-client && npm run dev -- --pay
```
