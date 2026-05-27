# MVP 001D - Persistent Request / Payment / Report Logs

Date: 2026-05-27

Branch: `mvp-001b1-controlled-payment`

Previous milestone: MVP 001C - DeFi Guardian mock adapter

## Purpose

MVP 001D adds durable local evidence for the paid API flow without changing the
x402 payment configuration or executing a new payment.

The audit trail records:

- request received;
- payment requirement emitted;
- dry-run/payment outcome;
- report generated;
- timestamp;
- wallet;
- position summary;
- risk score;
- final status code.

## Why JSONL

JSONL was chosen because it is append-only, easy to inspect with PowerShell,
simple to import into SQLite later, and adequate for a local audit trail.

No database dependency was added in this milestone.

## Log locations

Runtime logs are written under the repository root:

```text
logs/seller-events.jsonl
logs/buyer-events.jsonl
```

Generated logs are ignored by Git:

```text
logs/
*.jsonl
```

## Seller events

Seller event types:

- `seller.request_received`
- `seller.payment_required`
- `seller.report_generated`
- `seller.response_finished`
- `seller.error`

The seller logs both report endpoints:

```text
POST /mock/defi-risk-report
POST /paid/defi-risk-report
```

The audit middleware runs before x402 middleware. This means unpaid requests to
`/paid/defi-risk-report` are logged even when x402 intercepts the request and
returns HTTP 402 before the paid route handler runs.

## Buyer events

Buyer dry-run event types:

- `buyer.request_started`
- `buyer.payment_requirements_received`
- `buyer.dry_run_completed`
- `buyer.error`

The buyer sends:

```text
X-Agentic-Request-Id: <uuid>
```

The seller prefers the incoming request ID and echoes it as:

```text
X-Agentic-Request-Id: <same id>
```

This allows seller and buyer JSONL rows to be correlated.

## Fields captured

Events may include:

- `eventType`
- `timestamp`
- `requestId`
- `method`
- `path`
- `wallet`
- `position.protocol`
- `position.chain`
- `position.tokenId`
- `position.pair`
- `statusCode`
- `durationMs`
- `payment.network`
- `payment.asset`
- `payment.amountAtomic`
- `payment.amountUsd`
- `payment.mode`
- `report.reportId`
- `report.mode`
- `report.riskScore`
- `report.riskLevel`
- `report.recommendation`
- `outcome`

Not every event contains every field.

## Fields explicitly not captured

The loggers do not capture:

- private keys;
- CDP secrets;
- `.env` contents;
- Authorization headers;
- cookies;
- full request headers;
- full x402 payment signatures;
- full `PAYMENT-REQUIRED` header values;
- raw payment payloads.

Only summarized payment requirement details are logged.

## Example redacted log lines

Seller mock report:

```json
{"eventType":"seller.report_generated","requestId":"test-mock-001","path":"/mock/defi-risk-report","report":{"reportId":"mock-report-001","mode":"adapter-mock","riskScore":100,"riskLevel":"critical","recommendation":"urgent-review"}}
```

Seller unpaid paid endpoint:

```json
{"eventType":"seller.response_finished","requestId":"test-paid-unpaid-001","path":"/paid/defi-risk-report","statusCode":402,"payment":{"network":"eip155:84532","asset":"USDC","amountAtomic":"1000","amountUsd":"0.001","mode":"required"}}
```

Buyer dry-run completion:

```json
{"eventType":"buyer.dry_run_completed","requestId":"<uuid>","path":"/paid/defi-risk-report","dryRun":true,"statusCode":402,"payment":{"network":"eip155:84532","asset":"USDC","amountAtomic":"1000","amountUsd":"0.001","maxAmountUsd":"0.001"},"outcome":"dry_run_no_payment"}
```

## Validation commands

Build seller:

```powershell
cd D:\agentic-payments-lab\seller-api
npm.cmd run build
```

Build buyer:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run build
```

Start seller locally:

```powershell
cd D:\agentic-payments-lab\seller-api
npm.cmd run dev
```

Health:

```powershell
curl.exe http://localhost:4021/health
```

Mock endpoint:

```powershell
curl.exe -X POST http://localhost:4021/mock/defi-risk-report `
  -H "Content-Type: application/json" `
  -H "X-Agentic-Request-Id: test-mock-001" `
  -d "{\"wallet\":\"0x0000000000000000000000000000000000000000\",\"position\":{\"protocol\":\"pancakeswap\",\"chain\":\"bsc\",\"tokenId\":\"demo-position-001\",\"pair\":\"CAKE/BNB\",\"rangeStatus\":\"near_edge\",\"liquidityUsd\":420,\"impermanentLossEstimatePct\":3.4,\"healthFlags\":[\"manual-review\"]}}"
```

Expected:

- HTTP 200;
- `mode = adapter-mock`;
- risk score present;
- seller log contains `requestId = test-mock-001`;
- seller log contains `seller.report_generated`.

Paid endpoint without payment:

```powershell
curl.exe -i -X POST http://localhost:4021/paid/defi-risk-report `
  -H "Content-Type: application/json" `
  -H "X-Agentic-Request-Id: test-paid-unpaid-001" `
  -d "{\"wallet\":\"0x0000000000000000000000000000000000000000\",\"position\":{\"protocol\":\"pancakeswap\",\"chain\":\"bsc\",\"tokenId\":\"demo-position-001\"}}"
```

Expected:

- HTTP 402 Payment Required;
- seller log contains `requestId = test-paid-unpaid-001`;
- seller log contains `seller.response_finished` with `statusCode = 402`;
- seller log contains summarized payment requirement details.

Buyer dry-run:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run dev -- --dry-run
```

Expected:

- HTTP 402 detected;
- network: `eip155:84532`;
- asset: USDC;
- amount: `1000` atomic / `$0.001`;
- no payment attempted;
- buyer log contains `buyer.dry_run_completed`;
- seller log contains the corresponding unpaid 402 event with the same
  request ID.

Inspect logs:

```powershell
Get-Content D:\agentic-payments-lab\logs\seller-events.jsonl -Tail 20
Get-Content D:\agentic-payments-lab\logs\buyer-events.jsonl -Tail 20
```

## Validation result

Observed during MVP 001D:

- seller build: pass;
- buyer build: pass;
- health endpoint: HTTP 200;
- mock endpoint: HTTP 200 with `mode = adapter-mock`;
- unpaid paid endpoint: HTTP 402 Payment Required;
- buyer dry-run: pass, no payment attempted;
- seller log contained `test-mock-001`;
- seller log contained `seller.report_generated`;
- seller log contained `test-paid-unpaid-001`;
- seller log contained `seller.response_finished` with `statusCode = 402`;
- buyer log contained `buyer.dry_run_completed`;
- seller and buyer dry-run logs shared the same generated request ID.

## Safety confirmation

- No x402 payment was executed in this phase.
- No mainnet was used.
- No USDT was used.
- No private keys were printed.
- No CDP secrets were printed.
- No `.env` files were modified.
- `D:\defi_guardian` was not read or modified.
- Generated JSONL logs were not committed.

## Next recommended milestone

Recommended next milestone: MVP 001E - Add local log viewer / summary CLI.

The project now has an audit trail. A small summary command can turn those
JSONL records into a product-ready operational view before connecting the real
DeFi Guardian engine.
