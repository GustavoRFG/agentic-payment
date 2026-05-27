# MVP 001F - Add Minimal Local Dashboard Page

## Purpose

MVP 001F adds a minimal, local, static HTML dashboard generated from the
existing audit summary contract. It gives the project a one-page view of the
x402 buyer/seller flow without running a server, exposing secrets, or
touching the payment path.

The dashboard renders only the sanitized fields already produced by the MVP
001E summary CLI - the same shape returned by:

```powershell
npm.cmd run logs:summary -- --json
```

## Why a static dashboard

We deliberately avoided Next.js, Vite, React, and any web server for this
milestone:

- the summary contract is already stable;
- the data is local-only and never updates without a CLI run;
- a single self-contained `dashboard/index.html` is trivial to share and
  trivial to inspect for safety;
- there is no client-side JavaScript, no remote font, no CDN, and no
  external tracking script;
- there is no runtime fetch and no auth surface.

If a refresh/export workflow proves useful (MVP 001G), it can be layered on
top of this artifact without changing the data contract.

## Input data source

The renderer reuses the same audit summary logic as the CLI:

- `tools/log-summary.ts` was refactored to export `buildAuditSummary()`
  while preserving its CLI behavior via an entry-point guard;
- `tools/render-dashboard.ts` imports `buildAuditSummary` and renders the
  returned shape into HTML;
- inputs are still only `logs/seller-events.jsonl` and
  `logs/buyer-events.jsonl`;
- `.env`, `secrets/`, and `D:\defi_guardian` are never read.

If both log files are missing, the dashboard still renders with zeroed KPIs
and an informational banner; nothing crashes.

## Generated output

```text
dashboard/index.html
```

Self-contained: embedded CSS, no JavaScript, no remote assets. Safe to open
directly with a browser via `Start-Process dashboard/index.html`.

## Commands

From the repository root:

```powershell
npm.cmd run dashboard:render
```

Optional convenience:

```powershell
npm.cmd run dashboard:open
```

Underlying invocation goes through seller-api so the existing tsx dev
dependency is reused:

```text
npm --prefix seller-api exec -- tsx tools/render-dashboard.ts
```

The renderer also accepts:

- `--limit <n>` - number of items in each "recent" table (default 10);
- `--out <path>` - override the output path (default
  `dashboard/index.html`).

## KPIs shown

Top-level KPI cards:

- seller events;
- buyer events;
- total 402 offers;
- dry-run requests;
- reports generated;
- average risk score;
- unique request IDs;
- correlated buyer/seller request IDs;
- malformed log lines (with per-source hint);
- errors.

Reports section:

- average / min / max risk score;
- paid and mock report counts when inferable;
- risk level counts;
- recommendation counts.

Payments section:

- network counts;
- asset counts;
- amount (atomic) counts;
- amount (USD) counts;
- total 402 offers / total dry-run outcomes;
- identity rollup (unique request IDs, unique wallets, correlated IDs).

Recent activity tables:

- recent seller events;
- recent buyer events;
- recent generated reports;
- recent errors.

A footer reminds the reader that the dashboard renders only sanitized
summary fields.

## Safety rules

The dashboard renderer must not:

- execute any x402 payment;
- run `npm.cmd run dev -- --pay`;
- use mainnet;
- use USDT;
- print or read private keys, CDP secrets, or `.env`;
- read or modify `D:\defi_guardian`;
- commit `logs/`, `secrets/`, `*.jsonl`, `.env`, `node_modules/`, `dist/`,
  or `.codex_tmp/`;
- load remote fonts, JS, CSS, or tracking scripts.

The renderer reuses the sanitization already applied by
`tools/log-summary.ts`:

- field names matching `privateKey`, `authorization`, `cookie`,
  `paymentHeader`, `signature`, `secret`, `seed`, or `mnemonic` are never
  exported as values;
- suspicious string values are reported as `[redacted suspicious text]`;
- redaction warning counts are surfaced in the summary.

All embedded values go through HTML escaping in `tools/render-dashboard.ts`
before they hit the page, so the dashboard remains safe even if a future
audit field contains HTML-like characters.

## Validation results

Validated commands for this milestone:

```powershell
cd D:\agentic-payments-lab\seller-api
npm.cmd run build

cd D:\agentic-payments-lab\buyer-client
npm.cmd run build

cd D:\agentic-payments-lab
npm.cmd run logs:summary
npm.cmd run logs:summary -- --json
npm.cmd run logs:summary -- --limit 2
npm.cmd run dashboard:render
```

Expected behavior:

- no x402 payment is attempted;
- both subpackage TypeScript builds still pass;
- the existing CLI summary commands continue to work;
- `dashboard:render` writes `dashboard/index.html` with embedded CSS and
  no external assets;
- if logs are missing, the renderer still produces a valid HTML page with
  zeroed KPIs and an explanatory banner instead of crashing.

## Next recommended milestone

**MVP 001G - Add dashboard refresh/export workflow.**

Rationale: now that the static dashboard is the canonical local view of
the x402 flow, the next safe step is a small refresh/export workflow that
makes it easy to regenerate, snapshot, or share the dashboard from the
same audit data, before introducing the real DeFi Guardian engine in
MVP 002.
