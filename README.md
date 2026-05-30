# Agentic Payments Lab

A local x402-powered proof of concept for paid AI-agent API calls, DeFi risk
reports, and auditable dashboard evidence.

## One-line Summary

Agentic Payments Lab demonstrates how an AI agent can discover a paid API
requirement, reason about payment terms, and receive a DeFi risk report through
an x402-style paid service flow — all observable locally and reproducible with
one command.

## Why This Matters

- AI agents will increasingly need to pay for APIs, data, tools, and services
  on behalf of their users.
- Stablecoin-based payment rails make programmable, pay-per-use access
  technically practical without billing accounts or subscriptions.
- [x402](https://x402.org/) provides an HTTP-native payment pattern: a
  resource server replies `HTTP 402 Payment Required` with structured payment
  requirements, and the client decides whether to pay.
- This lab explores how specialized, agent-consumable services — like a DeFi
  position risk report — could be exposed and monetized through such a flow.

This is a proof of concept, not a product. It does not move real money in its
default demo path.

## What This MVP Demonstrates

- An x402 buyer/seller scaffold over Express + TypeScript.
- A controlled x402 payment already validated on Base Sepolia (testnet).
- A DeFi Guardian mock risk report adapter exposed by the seller.
- Persistent JSONL audit logs for every relevant buyer and seller event.
- A local audit summary CLI that aggregates those logs into KPIs.
- A static, self-contained local dashboard rendered from the same KPI shape.
- Dashboard export snapshots (timestamped) for evidence sharing.
- A one-command local demo that exercises the full flow safely.

## Architecture

Default local demo flow (no payment is executed):

```
buyer-client
   |
   | dry-run request
   v
seller-api /paid/defi-risk-report
   |
   | HTTP 402 Payment Required
   v
buyer-client parses x402 terms
   |
   | no payment in local demo
   v
audit logs + dashboard

/mock/defi-risk-report
   |
   v
DeFi Guardian mock adapter
   |
   v
structured risk report
```

Previously validated controlled payment path (Base Sepolia testnet only,
**not** exercised by `demo:local`):

```
buyer-client --pay
   |
   | Base Sepolia USDC x402 payment
   v
seller-api returns paid report
```

`npm.cmd run demo:local` never runs `--pay`, never touches mainnet, and never
moves USDT.

## Current Demo Flow

`npm.cmd run demo:local`:

1. Verifies that local port `4021` is free.
2. Starts `seller-api` with pinned safe environment overrides
   (`X402_NETWORK=eip155:84532`, micro price cap, empty buyer/CDP secrets).
3. Waits for `GET http://localhost:4021/health`.
4. Calls `POST /mock/defi-risk-report` with a demo position.
5. Runs `buyer-client` with `--dry-run` against the paid endpoint and decodes
   the HTTP 402 requirements without signing anything.
6. Renders `dashboard/index.html`.
7. Exports a timestamped dashboard snapshot.
8. Lists existing dashboard exports.
9. Stops the seller process tree.
10. Prints `RESULT: LOCAL_DEMO_SUCCEEDED` on success.

A successful run leaves audit logs, the dashboard HTML, and an export snapshot
on disk — all uncommitted by design.

## Quickstart

Windows / PowerShell:

```powershell
cd D:\agentic-payments-lab
npm.cmd install
npm.cmd run install:all
npm.cmd run demo:local
npm.cmd run dashboard:open
```

`install:all` runs `npm install` inside both `seller-api/` and `buyer-client/`.
The default demo does **not** require any private key, faucet funding, or
mainnet wallet.

## Commands

| Command | What it does |
| ------- | ------------ |
| `npm.cmd run demo:local` | One-shot local demo: seller up, mock report, buyer dry-run, dashboard, export, seller down. |
| `npm.cmd run logs:summary` | Human-readable KPI summary over the local audit logs. |
| `npm.cmd run logs:summary -- --json` | Same summary as JSON for piping or testing. |
| `npm.cmd run dashboard:render` | Re-render `dashboard/index.html` from current logs. |
| `npm.cmd run dashboard:open` | Open the current dashboard in the default browser. |
| `npm.cmd run dashboard:export` | Snapshot the current dashboard under `dashboard/exports/<timestamp>/`. |
| `npm.cmd run dashboard:list-exports` | List existing dashboard snapshots. |
| `npm.cmd run seller:dev` | Run the seller in dev mode (used inside `demo:local`; manual use is optional). |
| `npm.cmd run buyer:dev -- --dry-run` | Run the buyer in dry-run only; never signs. |

Everything else (including any `--pay` path) is out of scope for the default
demo and is intentionally left to a deliberate, manual session.

## Dashboard

`dashboard/index.html` is a single self-contained file: embedded CSS, no
JavaScript, no remote assets, no analytics. It is rendered from the same audit
summary shape exposed by `logs:summary -- --json`.

KPIs surfaced:

- Seller events
- Buyer events
- Total 402 offers
- Dry-run requests
- Reports generated
- Average risk score (when inferable)
- Unique request IDs
- Correlated buyer/seller IDs
- Recent events
- Recent reports
- Errors

The dashboard is the canonical local view of "is the flow working and
producing the evidence we expect?".

`dashboard/index.html` is a **generated static artifact**, committed as the
canonical sample output so GitHub visitors can see a representative dashboard.
It is refreshed by `dashboard:render` and the demo, so its KPI numbers will
drift between commits. Timestamped exports under `dashboard/exports/` are
**local-only and git-ignored**.

## Screenshots

- [Local audit dashboard](docs/screenshots/dashboard-local-audit.png) — the
  static dashboard rendered from sanitized KPI fields.
- Refresh instructions:
  [docs/screenshots/README.md](docs/screenshots/README.md).

## Demo Checklist

See [docs/public-demo-checklist.md](docs/public-demo-checklist.md) for the
pre-recording / pre-presentation checklist and the safety statement.

## Safety Model

- The default local demo does **not** execute payment.
- The demo uses buyer dry-run only — the buyer parses the x402 requirement and
  exits without signing.
- The demo avoids mainnet and USDT by construction; the seller is pinned to
  Base Sepolia (`eip155:84532`) and USDC.
- `.env` files and `secrets/` are never read or committed; only `.env.example`
  is in git.
- The audit summary CLI and dashboard renderer redact any field whose name
  looks like a key, header, signature, secret, seed, or mnemonic, and never
  print payment-header values.
- Generated runtime artifacts (`logs/`, `dashboard/exports/`, `*.jsonl`) are
  ignored by git.
- The lab does not call the production Coinbase Agentic Wallet, does not call
  `make_http_request_with_x402` in this milestone, and does not read or modify
  `D:\defi_guardian` except for the MVP 002A read-only discovery pass.

## Current Limitations

- The DeFi risk report is a mock adapter output, not a connection to a real
  on-chain DeFi Guardian engine.
- The dashboard is static, local, and refreshed only by an explicit command.
- The controlled x402 payment path is validated on Base Sepolia testnet but is
  not part of the default `demo:local` flow.
- There is no production auth, no billing dashboard, and no hosted seller
  endpoint yet.
- There is no real user treasury, payment router, or agent integration yet.

## Roadmap

- **MVP 001I** — public demo README / pitch flow.
- **MVP 001J** — repo hygiene, screenshots, and public demo
  polish.
- **MVP 002A (this milestone)** — DeFi Guardian discovery and adapter
  contract.
- **MVP 002B** — sanitized DeFi Guardian snapshot through `adapter-real-file`.
- **MVP 002** — connect the real DeFi Guardian engine in place of the mock
  adapter.
- **MVP 003** — add a hosted seller endpoint (still testnet by default).
- **MVP 004** — add an agent / MCP buyer integration.
- **MVP 005** — prototype an AI Treasury / Payment Router that brokers
  payments on behalf of an agent.

Immediate recommended next milestone given current repo state: **MVP 002B -
generate a sanitized DeFi Guardian snapshot and feed it through
`adapter-real-file`**.

## Demo Pitch

> An AI agent asks a local service for a DeFi position risk report. The
> service answers with `HTTP 402 Payment Required`, encoding the price, the
> stablecoin, the network, and the receiver. The agent's buyer client parses
> those terms in a dry-run path and decides not to pay. The seller records
> the offer; the buyer records the dry-run decision. A local dashboard
> aggregates both sides and shows a coherent, auditable trail. The same flow
> has been driven through a real Base Sepolia USDC payment in a controlled
> test, isolated from the default demo so the documentation flow stays
> reproducible without funds.

See [docs/public-demo-pitch.md](docs/public-demo-pitch.md) for the longer
version aimed at engineers, founders, and investors, and
[docs/linkedin-demo-post-draft.md](docs/linkedin-demo-post-draft.md) for a
short post draft.

## Status

Active prototype, single-developer scope. Local-first by design. Latest
completed milestones:

- MVP 001A — x402 buyer/seller scaffold
- MVP 001B.0 — readiness/safety checks
- MVP 001B.1 — controlled Base Sepolia x402 payment
- MVP 001C — DeFi Guardian mock adapter
- MVP 001D — persistent audit logs
- MVP 001E — local audit summary CLI
- MVP 001F — minimal local dashboard page
- MVP 001G — dashboard refresh / export workflow
- MVP 001H — local demo script
- MVP 001I — public demo README / pitch flow
- MVP 001J — repo hygiene, screenshots, and public demo polish
- MVP 002A - DeFi Guardian discovery and adapter contract (this milestone)

Milestone notes for each step live under [`docs/`](docs/).
