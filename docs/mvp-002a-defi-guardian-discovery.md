# MVP 002A - DeFi Guardian Discovery + Adapter Contract

Date: 2026-05-30

## Purpose

MVP 002A prepares the seller API to move from the current DeFi Guardian mock
adapter to a real DeFi Guardian-backed adapter without changing the existing
x402 payment flow, buyer dry-run, audit logs, summary CLI, dashboard, exports,
or public demo path.

This is not full real integration. Mock mode remains the default.

## Read-only safety boundary

`D:\defi_guardian` was inspected read-only. No files were edited there, no
packages were installed, and no transaction-capable scripts were run.

The inspection avoided:

- x402 payment execution
- mainnet payment activity
- USDT payment activity
- wallet transaction execution
- harvest, rebalance, approve, collect, claim, swap, bridge, stake, unstake,
  transfer, or send actions
- private key or CDP secret access
- `.env` file reads

The only DeFi Guardian operations used were file listing, git status/log, and
source/docs reads.

## DeFi Guardian inspection summary

Repository inspected:

```text
D:\defi_guardian
```

Latest observed commits:

```text
6804a34 fix(watchlist): archive replaced positions and reset baseline
f602929 feat(advisor): add range decision engine
94c3e43 feat(accounting): add full wallet balance analysis
ee0bbad fix(accounting): guard ledger against incomparable snapshot false positives
fe7594f feat(accounting): track realized yield buckets and wallet residuals
```

Observed top-level project shape:

- `src/` - TypeScript watcher, PancakeSwap/Aave read clients, metrics payloads.
- `strategy/` - Python FastAPI strategy API, reports, dashboard response
  builders, valuation, alerts, range advisor, ledger, wallet analysis.
- `dashboard/` - React dashboard over `/dashboard/*` API responses.
- `docs/` - safety, architecture, reports, dashboard, range-advisor docs.

Observed package scripts relevant to integration:

- `report:portfolio` - Python portfolio report over persisted data.
- `report:alerts` - Python alerts report over persisted alerts.
- `report:aave` - Python Aave wallet exposure report.
- `guardian:watch` / `dev` - watcher loop / one-shot chain reads plus strategy
  API calls.
- `discover:v3-wallet-nfts` - wallet discovery reads.
- `resolve:owners` - read-only ownership resolver with optional JSON output.
- `scan:aave` - Aave wallet scanner.

The DeFi Guardian docs state Phase 0/1 are read-only and explicitly exclude
transaction signing or broadcasting. Even so, MVP 002A does not call those
scripts from the seller because several paths can read `.env`, call RPC, post
to the strategy API, or write local MongoDB snapshots.

## Data shape findings

Stable fields available in DeFi Guardian source/type contracts:

- Position identity: `protocol`, `tokenId` or `token_id`.
- Chain: `chainId` / `chain_id`, generally BNB Chain `56`.
- Pair: `pair`, or `token0Symbol` + `token1Symbol`.
- Range: `inRange`, `state`, `status`, `rangeRiskLevel`,
  `recommendedAction`.
- Liquidity/value: `positionValueUsd`, `currentPositionValueUsd`,
  `lpPrincipalNavUsd`, `totalWalletEconomicValueUsd`.
- Fees/rewards: `estimatedCollectibleLpFeesUsd`, `lpFeesUsd`,
  `pendingCakeUsd`, `pendingFarmCakeUsd`, `currentCollectibleLpFeesUsd`.
- Dashboard views: overview, positions, range actions, range advisor, alerts,
  performance, history, harvest ledger, wallet analysis.

No committed runtime JSON snapshot suitable for direct seller ingestion was
found. JSON files in the repo were package metadata, TypeScript config, local
tool settings, and contract ABIs, not sanitized report snapshots.

## Discovery matrix

| Candidate source | Path | Type | Read-only? | Contains wallet? | Contains tokenId? | Contains risk/range/liquidity? | Output shape | Can be called from seller-api? | Recommendation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Sanitized dashboard snapshot JSON | Future exported file outside `D:\defi_guardian` source | JSON | Yes | Likely yes | Yes | Yes | `{ overview, positions, rangeActions, rangeAdvisor, alerts }` or a positions array | Yes, by file read | Preferred for MVP 002B |
| Dashboard response builders | `strategy/api/dashboard_routes.py`, `strategy/dashboard/service.py`, `strategy/api/dashboard_schemas.py` | Python API/modules | Mostly read-only GET paths; one manual confirmation POST writes local DB | Yes | Yes | Yes | Typed Pydantic response models | Unclear; service/process coupling | Use as shape reference, not direct dependency |
| Dashboard TypeScript API types | `dashboard/src/api/types.ts` | Type definitions | Yes | Possible in data, none in file contract except examples/tests elsewhere | Yes | Yes | TS interfaces for dashboard JSON | Yes as reference only | Good contract reference |
| Portfolio text report | `npm.cmd run report:portfolio` -> `strategy/reports/portfolio_summary.py` | CLI/text | Likely read-only DB report, but reads config | Yes | Yes | Yes | Human text, not stable JSON | Unclear | Not selected for MVP 002A |
| Alerts text report | `npm.cmd run report:alerts` -> `strategy/reports/alerts.py` | CLI/text | Likely read-only DB report, but reads config | Subject may include position/wallet context | Yes | Alerts only | Human text | Unclear | Not sufficient alone |
| Metrics/alert response summary | `src/api/strategyClient.ts`, `strategy/api/schemas.py`, `strategy/valuation/service.py` | HTTP payload/module | POST path writes DB when used live | Yes | Yes | Yes | `AlertResponse.portfolio` camelCase summary | No for MVP 002A | Useful future snapshot source after sanitization |
| Watcher one-shot | `npm.cmd run dev -- --once` / `guardian:watch` | CLI/process | Chain reads only, but writes local analytics through strategy API | Yes | Yes | Yes | Posts metrics to strategy API | No | Do not call from seller adapter |
| Owner resolver JSON | `npm.cmd run resolve:owners -- --json` | CLI/JSON | RPC read-only | Yes | Yes | No | `{ chainId, results }` | Possible but insufficient | Not enough for risk report |
| Aave scanner | `npm.cmd run scan:aave` | CLI/process | RPC reads, likely persists snapshots | Yes | No LP tokenId | Aave health only | Aave snapshots | No | Out of scope for LP report |

## Recommended strategy

Strategy A - file-based adapter.

Reasoning:

- It is the safest integration path.
- The seller does not spawn DeFi Guardian processes.
- The seller does not call RPC or MongoDB.
- The seller does not read `.env`.
- A sanitized snapshot can be generated deliberately in a later milestone and
  reviewed before the seller consumes it.
- It keeps the x402 seller boundary stable.

CLI or module integration should wait until DeFi Guardian has a stable,
explicitly read-only JSON export command that does not require secrets and does
not mutate local state.

## Adapter mode contract

Environment variables are optional and read from `process.env` only:

```text
DEFI_GUARDIAN_ADAPTER_MODE=mock
DEFI_GUARDIAN_SNAPSHOT_PATH=
DEFI_GUARDIAN_CLI_COMMAND=
```

Supported modes:

- `mock` / `adapter-mock` -> current mock adapter behavior.
- `real-file` / `adapter-real-file` -> read a local JSON snapshot and map known
  fields into the existing `RiskReport` shape.
- `real-cli` / `adapter-real-cli` -> reserved skeleton; no command execution in
  MVP 002A.

Output report modes:

- `adapter-mock`
- `adapter-real-file`
- `adapter-real-cli`

If no env is set, behavior remains the existing mock adapter path.

## Implemented in MVP 002A

- Added `DefiGuardianReportMode` to the seller report type contract.
- Added `seller-api/src/domain/defiGuardianAdapterMode.ts` for mode/env
  resolution.
- Added `seller-api/src/domain/defiGuardianRealAdapter.ts` for read-only
  file-based snapshot parsing and mapping.
- Updated `seller-api/src/domain/defiGuardianAdapter.ts` to select the mode and
  fall back safely to mock data with explicit warnings when real mode is not
  configured or cannot map data.
- Kept mock mode as the default and kept the existing Express/x402 wiring
  unchanged.

The real-file adapter refuses obvious secret/env paths, validates that the
snapshot path exists and is a file, parses JSON safely, searches for known
position arrays/objects, maps known DeFi Guardian fields, and returns warnings
instead of throwing on missing data.

`adapter-real-cli` intentionally does not execute `DEFI_GUARDIAN_CLI_COMMAND`
in this milestone.

## Validation results

Completed from `D:\agentic-payments-lab`:

```text
npm.cmd run demo:local
RESULT: LOCAL_DEMO_SUCCEEDED
Mock report: OK
Buyer dry-run: OK
Dashboard render: OK
Dashboard export: OK
x402 payment attempted: No
Mainnet used: No
USDT used: No
Secrets touched: No
```

```text
npm.cmd run logs:summary
Result: pass
Seller events: 60
Buyer events: 27
HTTP 402 offers: 11
Dry-run outcomes: 9
Reports generated: 9
Last report mode: adapter-mock
```

```text
npm.cmd run dashboard:render
Result: pass
Output: dashboard/index.html
Bytes: 19506
```

```text
npm.cmd run dashboard:export
Result: pass
Export id: 2026-05-29_23-18-49
```

```text
npm.cmd run dashboard:list-exports
Result: pass
Latest listed export: dashboard/exports/2026-05-29_23-18-49/index.html
```

```text
cd seller-api
npm.cmd run build
Result: pass

cd buyer-client
npm.cmd run build
Result: pass
```

```text
netstat -ano | Select-String -Pattern ':4021'
Result: only TIME_WAIT entries; no LISTENING process remained.
```

## Next recommended milestone

MVP 002B - Generate a sanitized DeFi Guardian snapshot and feed it through
`adapter-real-file`.
