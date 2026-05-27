# MVP 001G - Dashboard Refresh / Export Workflow

## Purpose

MVP 001G adds a small local workflow around the static dashboard introduced in
MVP 001F. The goal is to make the dashboard easy to regenerate, open, snapshot,
and list without adding a server or touching the x402 payment path.

Current dashboard path:

```text
dashboard/index.html
```

## Commands

Render the dashboard:

```powershell
npm.cmd run dashboard:render
```

Render and open the dashboard:

```powershell
npm.cmd run dashboard:refresh
```

Create a timestamped export:

```powershell
npm.cmd run dashboard:export
```

List local exports:

```powershell
npm.cmd run dashboard:list-exports
```

## Export Folder Structure

Exports are local runtime artifacts under:

```text
dashboard/exports/
```

Each export creates a timestamped folder:

```text
dashboard/exports/YYYY-MM-DD_HH-mm-ss/index.html
```

The export command also writes a local manifest:

```text
dashboard/exports/exports.json
```

Each manifest entry records:

- export id;
- creation timestamp;
- exported HTML path;
- source dashboard path;
- compact audit summary counts.

## What Is Not Exported

The export copies only the static dashboard HTML. It does not copy:

- runtime JSONL logs;
- `.env` files;
- secrets;
- private keys;
- CDP secrets;
- raw x402 payment headers;
- raw payment payloads;
- `node_modules`;
- build output directories.

`dashboard/exports/` is intentionally ignored by Git. Exports are local
artifacts, not source files.

## Safety Notes

This workflow does not:

- execute any x402 payment;
- run `npm.cmd run dev -- --pay`;
- call `make_http_request_with_x402`;
- use mainnet;
- use USDT;
- call Coinbase AWAL;
- read or modify `D:\defi_guardian`;
- read or modify `.env`.

The export summary reuses the sanitized local audit summary contract from
`tools/log-summary.ts`.

## Validation Results

Validated commands for this milestone:

```powershell
cd D:\agentic-payments-lab
npm.cmd run logs:summary
npm.cmd run logs:summary -- --json
npm.cmd run dashboard:render
npm.cmd run dashboard:export
npm.cmd run dashboard:list-exports

cd D:\agentic-payments-lab\seller-api
npm.cmd run build

cd D:\agentic-payments-lab\buyer-client
npm.cmd run build
```

Expected behavior:

- the existing dashboard still renders;
- export creates a timestamped local snapshot;
- list command prints available exports or a no-export message;
- generated exports remain ignored by Git;
- no payment command is run.

## Next Recommended Milestone

**MVP 001H - Add local demo script.**

A local demo script can generate one mock request, run one dry-run, refresh the
dashboard, and export a snapshot in one command, making the project demonstrable
without connecting the real DeFi Guardian engine yet.
