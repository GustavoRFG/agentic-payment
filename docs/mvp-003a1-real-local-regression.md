# MVP 003A.1B - Fresh Real-Local Regression With MongoDB Available

Date: 2026-06-01
Branch: `mvp-003a-consolidation`

## Result

`MVP_003A1_REAL_LOCAL_REGRESSION_PASSED`

The fresh real-local snapshot gate now passes with the existing local MongoDB
container running. The exporter remained read-only: it emitted a sanitized
snapshot, detected no secrets, performed no MongoDB writes, made no RPC calls,
and attempted no transactions.

No payment path, signing path, broadcast path, wallet secret, `.env`, RPC
configuration, or transaction path was modified or executed.

## MongoDB Availability

- MongoDB listener: available on `0.0.0.0:27017` and `localhost:27017`
- MongoDB container: `defi_guardian_mongo`, image `mongo:7`, port `27017->27017`

## Commands

| Command | Result |
| --- | --- |
| `npm.cmd test` | Pass: 6 files, 23 tests |
| `npm.cmd run snapshot:refresh:local` | Pass: fresh sanitized snapshot exported and validated |
| `npm.cmd run snapshot:validate:local` | Pass: `SNAPSHOT_VALID`, 4 positions, no secrets |
| `npm.cmd run demo:real-local-file` | Pass: `REAL_LOCAL_FILE_DEMO_SUCCEEDED`, no fallback |
| `npm.cmd run demo:paid-real-local-dry-run` | Pass: `PAID_REAL_LOCAL_DRY_RUN_SUCCEEDED`, HTTP 402 unpaid |
| `npm.cmd run logs:summary` | Pass: 0 malformed lines, 0 redaction warnings |
| `seller-api`: `npm.cmd run build` | Pass: `tsc --noEmit` |
| `buyer-client`: `npm.cmd run build` | Pass: `tsc --noEmit` |
| `netstat -ano | Select-String -Pattern ':4021'` | Pass: no output, no listener |

## Fresh Snapshot Evidence

- Snapshot path: `runtime/defi-guardian-snapshots/latest.json`
- Fresh snapshot timestamp: `2026-06-01T20:46:25.981Z`
- Snapshot version: `defi-guardian-snapshot-v1`
- Snapshot source: `defi-guardian-local-sanitized-export`
- Positions exported: 4
- Token IDs: `6840401`, `6840680`, `6870599`, `6870615`
- Secrets detected by validator: No
- RPC called by exporter: No
- MongoDB writes by exporter: No
- Transactions attempted by exporter: No

## Scoring Evidence

The fresh snapshot omits `poolLiquidityUsd`, so pool liquidity remains explicit
as unknown. The adapter does not use `positionValueUsd` as pool liquidity.

`demo:real-local-file` selected:

- selected alias: `RX 3900`
- selected tokenId: `6840401`
- risk score: `88`
- pool liquidity: unknown
- recommendation: `rebalance-review`
- adapter-real-file fallback used: No

`demo:paid-real-local-dry-run` selected:

- selected alias: `carteira recuperada / Chrome principal`
- selected tokenId: `6840680`
- risk score: `48`
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
- MongoDB writes by exporter: No
- RPC called: No
- Valid controlled-payment confirmation token used: No
- Prohibited command executed: No

The controlled payment command was not run:

```powershell
npm.cmd run demo:paid-real-local-controlled -- --confirm ONE_BASE_SEPOLIA_PAYMENT
```

## Recommended Next Step

MVP 003B - Replace the bespoke controlled-payment script with one gated
integration test and execute exactly one Base Sepolia USDC payment only after
explicit approval.
