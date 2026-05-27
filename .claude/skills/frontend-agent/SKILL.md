---
name: frontend-agent
description: Use for frontend/UI work in Agentic Payments Lab, especially local dashboards, KPI cards, audit-log summaries, React/Next-style interface planning, and safe UI changes that must not alter payment, wallet, or x402 execution paths.
---

# frontend-agent — Agentic Payments Lab UI Skill

You are acting as a frontend-focused agent for the Agentic Payments Lab repository.

## Scope

Use this skill when the user asks to build, review, or improve:

- local dashboard pages;
- KPI cards;
- audit-log summary views;
- React/Next-style UI components;
- frontend data models derived from `npm run logs:summary`;
- local demo pages for x402 payment/report flows;
- visual presentation of seller/buyer audit events.

## Current product context

The project currently has:

- `seller-api`: Express/TypeScript seller with x402-protected paid report endpoint;
- `buyer-client`: TypeScript buyer with dry-run and controlled payment support;
- `tools/log-summary.ts`: local CLI that summarizes JSONL audit logs;
- `logs/seller-events.jsonl`: generated runtime seller audit log, ignored by Git;
- `logs/buyer-events.jsonl`: generated runtime buyer audit log, ignored by Git;
- `docs/mvp-001e-local-log-summary-cli.md`: current KPI/summary contract.

The next UI milestone is:

```text
MVP 001F — Add minimal local dashboard page
```

## Hard safety rules

- Never execute x402 payment.
- Never run:

  ```powershell
  npm.cmd run dev -- --pay
  ```

- Never use mainnet.
- Never use USDT.
- Never print or read private keys.
- Never print or read CDP secrets.
- Never modify `.env` files.
- Never commit generated logs.
- Never read or modify `D:\defi_guardian`.
- Never call Coinbase AWAL.
- Never call `make_http_request_with_x402`.
- Do not change x402 middleware configuration, payment amount, network, facilitator, or receiver address unless the user explicitly starts a payment/configuration task.

## Preferred frontend direction

For MVP 001F, prefer the smallest local dashboard that can render the existing summary data.

Good options:

1. A static local HTML dashboard generated from `npm run logs:summary -- --json`.
2. A tiny Vite/React app if the project already has or intentionally adds frontend tooling.
3. A simple Node script that writes `dashboard/index.html` from current logs.

Prefer option 1 or 3 before adding a full Next.js app.

Avoid overengineering.

## Dashboard MVP requirements

A minimal dashboard should show:

- total seller events;
- total buyer events;
- total 402 offers;
- dry-run requests;
- reports generated;
- average risk score;
- risk level counts;
- recommendation counts;
- unique request IDs;
- correlated buyer/seller request IDs;
- recent seller events;
- recent buyer events;
- recent generated reports;
- recent errors.

## Design style

Use a clean, technical SaaS dashboard style:

- dark theme by default;
- cards for KPIs;
- compact tables for recent events;
- clear labels;
- no excessive animation;
- no external tracking scripts;
- no remote fonts required;
- no secrets or raw payment headers on screen.

## Implementation rules

Before coding UI:

1. Read `package.json`.
2. Read `tools/log-summary.ts`.
3. Read `docs/mvp-001e-local-log-summary-cli.md`.
4. Decide whether to generate static HTML or add a minimal frontend package.

Prefer no new dependencies unless they clearly improve maintainability.

If adding scripts, keep Windows PowerShell compatibility.

If generating files, do not commit runtime logs.

## Validation rules

For dashboard work, validate with:

```powershell
npm.cmd run logs:summary
npm.cmd run logs:summary -- --json
```

If a dashboard script is added, validate it with its npm script.

Do not validate by running payment.

## Git hygiene

Stage only safe files:

- dashboard source;
- generated static HTML only if intentional;
- docs;
- package scripts.

Do not stage:

- `.env`;
- `secrets/`;
- `logs/`;
- `*.jsonl`;
- `node_modules/`;
- `dist/`;
- `.codex_tmp/`.

## Response format after frontend tasks

When completing a frontend task, report:

- files changed;
- command(s) added;
- validation commands run;
- whether any payment was attempted;
- whether secrets were touched;
- exact next step.
