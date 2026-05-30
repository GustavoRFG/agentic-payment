# MVP 002B - Sanitized Snapshot v1 + Deterministic Real-File Demo

Date: 2026-05-30

## Purpose

MVP 002B proves the `adapter-real-file` path end-to-end with deterministic,
public-safe data. It adds a versioned snapshot contract, a committed sanitized
fixture, a validator, and a local real-file demo while preserving the existing
mock default and x402 dry-run behavior.

This is still not live DeFi Guardian integration. No DeFi Guardian service,
RPC endpoint, MongoDB, wallet, or `.env` file is used.

## Snapshot v1 contract

The contract lives in:

```text
seller-api/src/domain/defiGuardianSnapshotV1.ts
```

Snapshot root:

```ts
interface DefiGuardianSnapshotV1 {
  snapshotVersion: "defi-guardian-snapshot-v1";
  generatedAt: string;
  source: "defi-guardian-local-sanitized-export";
  chainId: 56;
  positions: DefiGuardianSnapshotPositionV1[];
}
```

Position:

```ts
interface DefiGuardianSnapshotPositionV1 {
  protocol: "pancakeswap-v3" | "pancakeswap-infinity-cl" | string;
  tokenId: string;
  chain: "bsc";
  pair: string;
  walletAlias?: string;
  inRange: boolean;
  rangeStatus: "in_range" | "near_edge" | "out_of_range";
  positionValueUsd: number;
  estimatedCollectibleLpFeesUsd: number;
  impermanentLossEstimatePct?: number | null;
  rangeRiskLevel?: "LOW" | "MODERATE" | "HIGH" | "UNKNOWN";
  recommendedAction?: string;
  healthFlags?: string[];
}
```

Runtime validation is handwritten and rejects unsupported versions, invalid
root fields, missing `positions`, invalid position fields, non-finite numeric
values, secret-looking keys/values, and `.env` or `secrets` paths.

## Sanitization boundary

The committed fixture contains no real wallet addresses, no private keys, no
CDP values, no payment headers, no signatures, no raw RPC payloads, and no
DeFi Guardian runtime database output. It uses a wallet alias only.

Committed fixture:

```text
seller-api/src/fixtures/defiGuardianSnapshotV1.sample.json
```

Token ID:

```text
demo-real-file-001
```

## Fallback honesty fix

`RiskReport` now includes:

```ts
interface AdapterMetadata {
  requestedMode: DefiGuardianReportMode;
  resolvedMode: DefiGuardianReportMode;
  fallbackUsed: boolean;
  snapshotVersion?: string;
  source?: string;
}
```

Default mock:

```json
{
  "mode": "adapter-mock",
  "adapter": {
    "requestedMode": "adapter-mock",
    "resolvedMode": "adapter-mock",
    "fallbackUsed": false
  }
}
```

Successful real-file:

```json
{
  "mode": "adapter-real-file",
  "adapter": {
    "requestedMode": "adapter-real-file",
    "resolvedMode": "adapter-real-file",
    "fallbackUsed": false,
    "snapshotVersion": "defi-guardian-snapshot-v1",
    "source": "local-sanitized-json"
  }
}
```

Failed real-file fallback:

```json
{
  "mode": "adapter-mock",
  "adapter": {
    "requestedMode": "adapter-real-file",
    "resolvedMode": "adapter-mock",
    "fallbackUsed": true
  }
}
```

The adapter never reports `adapter-real-file` when mock data was actually used.

## Validation commands

```powershell
npm.cmd run snapshot:validate:sample
npm.cmd run demo:real-file
npm.cmd run demo:local
npm.cmd run logs:summary
npm.cmd run dashboard:render
cd seller-api
npm.cmd run build
cd ..\buyer-client
npm.cmd run build
netstat -ano | Select-String -Pattern ':4021'
```

## Deterministic real-file demo

`npm.cmd run demo:real-file`:

1. Checks missing-file fallback directly through the adapter.
2. Starts the seller with `DEFI_GUARDIAN_ADAPTER_MODE=real-file`.
3. Points `DEFI_GUARDIAN_SNAPSHOT_PATH` at the committed sanitized fixture.
4. Calls `POST /mock/defi-risk-report` for `demo-real-file-001`.
5. Verifies `mode=adapter-real-file`, `fallbackUsed=false`, snapshot version,
   risk score, and recommendation.
6. Runs buyer dry-run only against the paid endpoint.
7. Renders the dashboard.
8. Stops the seller process tree.

Expected success marker:

```text
RESULT: REAL_FILE_DEMO_SUCCEEDED
```

## Existing demo preservation

`npm.cmd run demo:local` remains the default public-safe flow and still uses
`adapter-mock` unless adapter env variables are deliberately set.

## Validation results

Initial MVP 002B validation:

```text
npm.cmd run snapshot:validate:sample
RESULT: SNAPSHOT_VALID
Version: defi-guardian-snapshot-v1
Positions: 1
Token IDs:
- demo-real-file-001
Secrets detected: No
```

```text
npm.cmd run demo:real-file
RESULT: REAL_FILE_DEMO_SUCCEEDED
Fallback honesty: OK
Real-file report: OK
Buyer dry-run: OK
Dashboard render: OK
x402 payment attempted: No
```

Final validation:

```text
npm.cmd run demo:local
RESULT: LOCAL_DEMO_SUCCEEDED
Mock report: OK
Buyer dry-run: OK
Dashboard render: OK
Dashboard export: OK
x402 payment attempted: No
```

```text
npm.cmd run logs:summary
Result: pass
Seller events: 72
Buyer events: 33
HTTP 402 offers: 13
Dry-run outcomes: 11
Reports generated: 11
Recent real-file report mode: adapter-real-file
Latest local demo report mode: adapter-mock
```

```text
npm.cmd run dashboard:render
Result: pass
Output: dashboard/index.html
Bytes: 19999
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

## What is still not live

- No live DeFi Guardian export.
- No `D:\defi_guardian` service startup.
- No RPC call.
- No MongoDB query.
- No `.env` read.
- No wallet signing or transaction construction.
- No real user wallet address in the fixture.

Future placeholder only:

```text
snapshot:export:local
```

That command should be implemented later after an approved read-only local
DeFi Guardian dashboard GET endpoint or explicit sanitized export script is
defined.

## Next recommended milestone

MVP 002C - Add an approved read-only local DeFi Guardian snapshot exporter and
test it with actual sanitized local data.
