# MVP 003A.1 - Real-Local Regression After Scoring Fix

Date: 2026-06-01
Branch: `mvp-003a-consolidation`

## Result

`MVP_003A1_REAL_LOCAL_REGRESSION_BLOCKED`

The downstream real-local regression passed against the existing sanitized
snapshot, but the full requested gate cannot be marked passed because
`npm.cmd run snapshot:refresh:local` failed before writing a fresh snapshot.
The failure was a local dependency issue: DeFi Guardian's read-only exporter
attempted to ping MongoDB at `localhost:27017`, and no MongoDB listener/service
was available.

No payment path, signing path, broadcast path, wallet secret, `.env`, RPC
configuration, or transaction path was modified or executed.

## Commands

| Command | Result |
| --- | --- |
| `npm.cmd test` | Pass: 6 files, 23 tests |
| `npm.cmd run snapshot:refresh:local` | Blocked: MongoDB connection refused on `localhost:27017` |
| `npm.cmd run snapshot:validate:local` | Pass: `SNAPSHOT_VALID`, 4 positions, no secrets |
| `npm.cmd run demo:real-local-file` | Pass: `REAL_LOCAL_FILE_DEMO_SUCCEEDED` |
| `npm.cmd run demo:paid-real-local-dry-run` | Pass: `PAID_REAL_LOCAL_DRY_RUN_SUCCEEDED` |
| `npm.cmd run logs:summary` | Pass: 0 malformed lines, 0 redaction warnings |
| `seller-api`: `npm.cmd run build` | Pass: `tsc --noEmit` |
| `buyer-client`: `npm.cmd run build` | Pass: `tsc --noEmit` |
| `netstat -ano | Select-String -Pattern ':4021'` | Pass: no output, no listener |

## Snapshot Evidence

- Existing snapshot: `runtime/defi-guardian-snapshots/latest.json`
- Snapshot generated at: `2026-06-01T04:12:26.098Z`
- Snapshot version: `defi-guardian-snapshot-v1`
- Snapshot source: `defi-guardian-local-sanitized-export`
- Snapshot positions: 4
- Token IDs: `6840401`, `6840680`, `6870599`, `6870615`
- Secrets detected by validator: No

The refresh command did not update this file during this regression; its
timestamp remained unchanged.

## Scoring Fix Evidence

The current adapter maps `poolLiquidityUsd` to normalized pool liquidity. It no
longer maps `positionValueUsd` to pool liquidity. The current snapshot omits
`poolLiquidityUsd`, so pool liquidity is explicit as unknown:

- liquidity estimated USD: `null`
- liquidity explanation: `Pool liquidity was not provided by sanitized DeFi Guardian snapshot v1 data.`
- risk driver: `Pool liquidity unknown.`
- risk driver: `Liquidity depth was not provided by the snapshot.`

`demo:real-local-file` selected:

- selected alias: `RX 3900`
- selected tokenId: `6840401`
- old risk score if documented: previous local logs show `100` for this tokenId after the old mapping
- new risk score: `88`
- pool liquidity: unknown
- recommendation: `rebalance-review`
- adapter-real-file fallback used: No

`demo:paid-real-local-dry-run` selected:

- selected alias: `carteira recuperada / Chrome principal`
- selected tokenId: `6840680`
- old risk score if documented: `60` in `docs/mvp-002d0-paid-real-local-dry-run.md`
- new risk score: `48`
- pool liquidity: unknown
- recommendation: `rebalance-review`
- adapter-real-file fallback used: No

## Paid Endpoint Dry-Run

- Protected endpoint unpaid response: HTTP 402
- Network: `eip155:84532`
- Asset: `USDC`
- Amount atomic: `1000`
- Amount USD: `0.001`
- Buyer dry-run: OK
- Seller stopped: Yes
- No `LISTENING` process remained on `:4021`

## Safety Confirmation

- Payment attempted: No
- Mainnet used: No
- USDT payment rail used: No
- Secrets printed: No
- MongoDB writes: No
- MongoDB read attempted: Yes, by `snapshot:refresh:local`; blocked because no local MongoDB was listening
- RPC called: No
- Valid controlled-payment confirmation token used: No
- Prohibited command executed: No

The controlled payment command was not run:

```powershell
npm.cmd run demo:paid-real-local-controlled -- --confirm ONE_BASE_SEPOLIA_PAYMENT
```

## Follow-Up Required

To mark this gate fully passed, rerun `npm.cmd run snapshot:refresh:local` in an
environment where the read-only DeFi Guardian persisted analytics MongoDB is
available, then rerun the downstream validation and dry-run commands.
