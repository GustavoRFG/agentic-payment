# MVP 001C - DeFi Guardian Mock Adapter

Date: 2026-05-27

Branch: `mvp-001b1-controlled-payment`

## Purpose

MVP 001C replaces the seller API's inline hardcoded mock report with a small
internal DeFi Guardian mock adapter while preserving the existing x402 payment
flow.

The paid report endpoint remains:

```text
POST /paid/defi-risk-report
```

The public unpaid mock endpoint remains:

```text
POST /mock/defi-risk-report
```

Both endpoints now use:

```text
defiGuardianAdapter.analyzePosition()
```

## Adapter architecture

The seller now has a small domain layer:

```text
seller-api/src/domain/reportTypes.ts
seller-api/src/domain/riskScoring.ts
seller-api/src/domain/defiGuardianAdapter.ts
seller-api/src/fixtures/samplePositions.ts
```

`server.ts` still owns Express and x402 middleware wiring. The adapter owns
payload normalization, deterministic mock scoring, report assembly, warnings,
checks, and recommendation text.

## Why real DeFi Guardian is not connected yet

This phase intentionally does not read or modify `D:\defi_guardian`.

The goal is to improve the seller report contract and keep the payment path
stable before introducing a real portfolio/risk engine. The adapter is
record-only mock logic and does not query chains, pools, private APIs, or local
external repositories.

## Input schema

Required fields:

```json
{
  "wallet": "0x0000000000000000000000000000000000000000",
  "position": {
    "protocol": "pancakeswap",
    "chain": "bsc",
    "tokenId": "demo-position-001"
  }
}
```

Optional fields with safe defaults:

```json
{
  "position": {
    "pair": "CAKE/BNB",
    "rangeStatus": "in_range",
    "liquidityUsd": 1380.19,
    "feesUsd": 3.42,
    "impermanentLossEstimatePct": null,
    "healthFlags": []
  }
}
```

Supported `rangeStatus` values:

- `in_range`
- `near_edge`
- `out_of_range`

Unknown or missing optional values fall back to the mock sample position.

## Output schema

The adapter returns a structured report:

```json
{
  "reportId": "mock-report-001",
  "mode": "adapter-mock",
  "generatedAt": "2026-05-27T00:00:00.000Z",
  "wallet": "0x...",
  "position": {
    "protocol": "pancakeswap",
    "chain": "bsc",
    "tokenId": "demo-position-001",
    "pair": "CAKE/BNB"
  },
  "risk": {
    "score": 42,
    "level": "medium",
    "drivers": []
  },
  "range": {
    "status": "in_range",
    "severity": "low",
    "explanation": "The mock adapter considers the position currently active."
  },
  "liquidity": {
    "estimatedUsd": 1380.19,
    "severity": "medium",
    "explanation": "Liquidity is sufficient for a demo position, but real pool depth is not connected yet."
  },
  "fees": {
    "estimatedUsd": 3.42,
    "comment": "Fee data is mocked until DeFi Guardian real integration."
  },
  "recommendation": {
    "action": "monitor",
    "confidence": "medium",
    "rationale": "Position is acceptable for a demo flow, but mock risk signals should be monitored before real integration."
  },
  "warnings": [
    "This is a mock adapter report, not financial advice.",
    "No real on-chain position data was queried."
  ],
  "checks": []
}
```

## Risk scoring rules

The mock scorer starts at `50`, then applies deterministic adjustments:

- `rangeStatus = in_range`: `-10`
- `rangeStatus = near_edge`: `+10`
- `rangeStatus = out_of_range`: `+30`
- `liquidityUsd >= 1000`: `-5`
- `liquidityUsd < 500`: `+15`
- `impermanentLossEstimatePct` absent: `+5`
- `impermanentLossEstimatePct <= 2`: `+5`
- `impermanentLossEstimatePct > 2 and <= 5`: `+15`
- `impermanentLossEstimatePct > 5`: `+30`
- `healthFlags` includes `zero-liquidity`: `+35`
- `healthFlags` includes `manual-review`: `+10`
- `healthFlags` includes `out-of-range`: `+25`

Score is clamped to `0..100`.

Risk levels:

- `0..24`: low
- `25..59`: medium
- `60..84`: high
- `85..100`: critical

Recommendation actions:

- low: `hold`
- medium: `monitor`
- high: `rebalance-review`
- critical: `urgent-review`

## Validation

Build:

```powershell
cd D:\agentic-payments-lab\seller-api
npm.cmd run build
```

Result: pass.

Seller health:

```powershell
curl.exe http://localhost:4021/health
```

Result: HTTP 200 with `{"ok":true,"service":"defi-guardian-paid-api"}`.

Public mock endpoint:

```powershell
curl.exe -X POST http://localhost:4021/mock/defi-risk-report `
  -H "Content-Type: application/json" `
  -d "{\"wallet\":\"0x0000000000000000000000000000000000000000\",\"position\":{\"protocol\":\"pancakeswap\",\"chain\":\"bsc\",\"tokenId\":\"demo-position-001\",\"pair\":\"CAKE/BNB\",\"rangeStatus\":\"near_edge\",\"liquidityUsd\":420,\"impermanentLossEstimatePct\":3.4,\"healthFlags\":[\"manual-review\"]}}"
```

Result: HTTP 200. Response included:

- `mode = adapter-mock`
- `risk.score = 100`
- `risk.level = critical`
- `recommendation.action = urgent-review`
- warnings present
- checks present

Paid endpoint without payment:

```powershell
curl.exe -i -X POST http://localhost:4021/paid/defi-risk-report `
  -H "Content-Type: application/json" `
  -d "{\"wallet\":\"0x0000000000000000000000000000000000000000\",\"position\":{\"protocol\":\"pancakeswap\",\"chain\":\"bsc\",\"tokenId\":\"demo-position-001\"}}"
```

Result: HTTP 402 Payment Required.

Buyer dry-run:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run dev -- --dry-run
```

Result:

- HTTP 402 detected
- network: `eip155:84532`
- asset: Base Sepolia USDC
- amount: `1000` atomic units / `$0.001`
- dry-run OK
- no payment attempted

## Safety confirmation

- No x402 payment was executed in this phase.
- No mainnet was used.
- No USDT was used.
- No private keys were printed.
- No CDP secrets were printed.
- No `.env` files were modified.
- `D:\defi_guardian` was not read or modified.
- The payment amount, network, and receiver behavior were not changed.

## Next step

Recommended next milestone: MVP 001D - Add persistent request/payment/report
logs.

This is safer than connecting the real DeFi Guardian engine immediately
because the seller now has a richer report contract, but still lacks durable
local evidence for requests, HTTP 402 offers, payment outcomes, and returned
reports. Persistent logs should come before real engine integration.
