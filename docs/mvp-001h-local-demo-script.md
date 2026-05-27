# MVP 001H - Local Demo Script

## Purpose

MVP 001H adds one safe local command that demonstrates the current Agentic
Payments Lab flow end to end without executing an x402 payment.

The demo starts the local seller, calls the public mock endpoint, runs the buyer
dry-run against the paid endpoint, renders the dashboard, exports a dashboard
snapshot, lists exports, stops the seller, and prints a final status summary.

## Command Usage

From the repository root:

```powershell
npm.cmd run demo:local
```

Optional flags:

```powershell
npm.cmd run demo:local -- --skip-open
npm.cmd run demo:local -- --no-export
```

The default does not open a browser. After a successful demo, open the dashboard
manually if desired:

```powershell
npm.cmd run dashboard:open
```

## What It Does

The local demo:

1. Checks that port `4021` is available.
2. Starts `seller-api` with safe local testnet environment overrides.
3. Waits for `GET http://localhost:4021/health`.
4. Calls `POST /mock/defi-risk-report` with a demo CAKE/BNB position.
5. Runs `buyer-client` with `--dry-run` only.
6. Renders `dashboard/index.html`.
7. Exports a timestamped dashboard snapshot unless `--no-export` is set.
8. Runs `dashboard:list-exports`.
9. Stops the seller process tree.
10. Prints `RESULT: LOCAL_DEMO_SUCCEEDED` on success.

## What It Proves

The demo proves:

- the seller can start locally;
- the public mock endpoint returns an adapter mock report;
- the paid endpoint returns HTTP 402 requirements when unpaid;
- the buyer dry-run decodes the requirement without signing;
- audit logs update local KPIs;
- the dashboard can be rendered and exported from local audit summaries.

## Safety Guarantees

The demo does not:

- execute an x402 payment;
- run `npm.cmd run dev -- --pay`;
- call `make_http_request_with_x402`;
- use mainnet;
- use USDT;
- print private keys;
- print CDP secrets;
- call Coinbase AWAL;
- read or modify `D:\defi_guardian`;
- modify `.env`.

The child process environment explicitly pins:

- `X402_NETWORK=eip155:84532`;
- `REPORT_PRICE_USD=$0.001`;
- `MAX_PAYMENT_USD=0.001`;
- empty buyer/CDP secret variables.

## Generated Locally

The demo may generate or update:

- `logs/seller-events.jsonl`;
- `logs/buyer-events.jsonl`;
- `dashboard/index.html`;
- `dashboard/exports/<timestamp>/index.html`;
- `dashboard/exports/exports.json`.

These are runtime artifacts and are not committed.

## Validation Results

Validated commands for this milestone:

```powershell
cd D:\agentic-payments-lab
npm.cmd run logs:summary
npm.cmd run dashboard:render
npm.cmd run dashboard:export
npm.cmd run dashboard:list-exports
npm.cmd run demo:local

cd D:\agentic-payments-lab\seller-api
npm.cmd run build

cd D:\agentic-payments-lab\buyer-client
npm.cmd run build
```

Expected behavior:

- `demo:local` prints `RESULT: LOCAL_DEMO_SUCCEEDED`;
- seller health check passes;
- mock report is returned with `mode=adapter-mock`;
- buyer dry-run detects HTTP 402, Base Sepolia, USDC, and `1000` atomic units;
- no payment is attempted;
- seller process is stopped at the end;
- generated logs and dashboard exports remain uncommitted.

## Next Recommended Milestone

**MVP 001I - Prepare public demo README / pitch flow.**

Now that one local command can generate evidence, refresh KPIs, and export a
snapshot, the next useful step is a public-facing demo README that explains the
flow clearly before connecting the real DeFi Guardian engine.
