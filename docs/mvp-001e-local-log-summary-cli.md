# MVP 001E - Local Log Viewer / Summary CLI

## Purpose

MVP 001E adds a local command-line summary for the JSONL audit logs created in
MVP 001D. It gives the project a terminal-based operational view before adding
a dashboard.

The command reads only local audit summaries:

- `logs/seller-events.jsonl`
- `logs/buyer-events.jsonl`

It does not execute payments, call x402 payment helpers, start a web server, or
read environment files.

## Usage

From the repository root:

```powershell
npm.cmd run logs:summary
```

Machine-readable output:

```powershell
npm.cmd run logs:summary -- --json
```

Limit recent sections:

```powershell
npm.cmd run logs:summary -- --limit 2
```

Invalid limits fall back to `5`.

## Metrics

The CLI prints:

- seller and buyer log paths and existence flags;
- malformed JSONL line counts;
- seller event totals by event type;
- seller HTTP 200, 402, and 500 counts;
- buyer event totals by event type;
- dry-run counts;
- generated report totals;
- paid/mock report counts when inferable;
- average, min, and max risk score;
- risk level and recommendation counts;
- payment requirement counts by network, asset, atomic amount, and USD amount;
- unique request IDs;
- unique wallets and request counts by wallet;
- correlated buyer/seller request ID count;
- recent seller events, buyer events, reports, and errors.

If a value cannot be inferred reliably, the human output prints `n/a`.

## JSONL Robustness

Missing files, empty files, and malformed lines are normal operating conditions.
The parser continues after malformed lines and reports:

- `Malformed seller log lines`
- `Malformed buyer log lines`

The JSON output includes the same counts under `malformedLines`.

## Safety Limits

The summary CLI does not print:

- private keys;
- CDP secrets;
- `.env` contents;
- authorization headers;
- cookies;
- full payment signatures;
- full `PAYMENT` headers;
- raw x402 payment payloads.

The CLI only prints intentionally summarized audit fields such as event type,
timestamp, request ID, status code, report risk summary, payment network, asset,
and summarized amounts.

If unexpected suspicious field names are present in audit events, the CLI does
not print their values and increments a redaction warning count.

## Validation Results

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
```

Expected behavior:

- no x402 payment is attempted;
- missing logs do not crash the CLI;
- malformed JSONL lines are counted;
- default output is human-readable;
- `--json` emits valid JSON;
- `--limit` controls recent sections.

## Next Recommended Milestone

MVP 001F - Add minimal local dashboard page.

The summary CLI now defines the KPI shape that a local dashboard can render
without changing the audit logger or payment flow.
