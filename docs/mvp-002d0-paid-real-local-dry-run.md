# MVP 002D.0 — Optional Paid-Report Real Local Source, Dry-Run Only

## Purpose

Prove that the x402-protected paid endpoint (`POST /paid/defi-risk-report`) can
be configured to serve an **actual sanitized local DeFi Guardian snapshot**
report, while preserving every safety invariant of the lab. This is a dry-run
milestone: it demonstrates the wiring and the HTTP 402 payment-required boundary
**without executing any payment**.

```text
snapshot:refresh:local (export + validate, read-only)
  → seller-api with adapter-real-file + actual local snapshot
  → POST /paid/defi-risk-report without payment
  → HTTP 402 Payment Required
  → buyer-client --dry-run
  → audit logs + dashboard
```

## Optional real-file paid-report mode

The seller adapter mode is selected per process from `DEFI_GUARDIAN_ADAPTER_MODE`.
For this demo the wrapper `tools/run-paid-real-local-dry-run.ts` starts a seller
with **safe, opt-in** env overrides:

```text
DEFI_GUARDIAN_ADAPTER_MODE=real-file
DEFI_GUARDIAN_SNAPSHOT_PATH=<absolute runtime snapshot path>
X402_NETWORK=eip155:84532          (Base Sepolia testnet)
REPORT_PRICE_USD=$0.001
MAX_PAYMENT_USD=0.001
BUYER_PRIVATE_KEY=                  (blank)
CDP_API_KEY_ID=                     (blank)
CDP_API_KEY_SECRET=                 (blank)
CDP_WALLET_SECRET=                  (blank)
```

The paid endpoint uses the **same adapter boundary** as the public endpoint, so
once a payment were ever accepted (future milestone, separate explicit
approval), the protected handler returns the same `adapter-real-file` report.

## Mock remains the default

This mode is strictly opt-in. The default public demo (`npm.cmd run demo:local`)
still runs `adapter-mock`, and no default adapter mode was changed. The
deterministic fixture demo (`demo:real-file`) and the actual-local demo
(`demo:real-local-file`) continue to behave exactly as before.

## Approved read-only snapshot workflow

The only external DeFi Guardian operation is the already-approved read-only
exporter, invoked through `snapshot:refresh:local`:

```powershell
npm.cmd run snapshot:refresh:local
# → AGENTIC_SNAPSHOT_EXPORTED (4 positions, 4 aliases)
# → SNAPSHOT_VALID (defi-guardian-snapshot-v1)
# raw wallet addresses emitted: No; secrets: No; RPC: No; MongoDB writes: No;
# transactions attempted: No.
```

The snapshot is written into this repo's **gitignored** `runtime/` directory and
is never committed. The seller reads only that local sanitized JSON file — it
never reads MongoDB and never calls RPC.

## Protected endpoint unpaid HTTP 402 result

`POST /paid/defi-risk-report` without any payment header:

```text
HTTP 402 Payment Required
network=eip155:84532
asset=USDC
amountAtomic=1000
amountUsd=0.001
```

## Buyer dry-run result

`buyer-client --dry-run` against the protected endpoint:

```text
received HTTP 402
network: eip155:84532
asset:   USDC
amount (atomic): 1000
dry-run OK. No payment attempted.
```

No signing, no payment header, no broadcast.

## Public real-file report result

`POST /mock/defi-risk-report` with the selected tokenId (public, no payment),
served from the actual local snapshot:

```text
HTTP 200
mode=adapter-real-file
adapter.requestedMode=adapter-real-file
adapter.resolvedMode=adapter-real-file
adapter.fallbackUsed=false
adapter.snapshotVersion=defi-guardian-snapshot-v1
risk score + recommendation present
```

Example from a local run: selected an in-range position (alias only, never the
raw address), `riskScore=60`, `recommendation=hold`.

## Audit logging result

The protected unpaid call produced the expected seller audit events:

```text
seller.request_received
seller.payment_required
seller.response_finished  statusCode=402
```

The buyer dry-run produced:

```text
buyer.request_started
buyer.payment_requirements_received
buyer.dry_run_completed
```

The public real-file report was logged with
`mode=adapter-real-file`, `adapter.requestedMode=adapter-real-file`,
`adapter.resolvedMode=adapter-real-file`, `adapter.fallbackUsed=false`.
No raw addresses, no raw snapshot contents, and no secrets were logged
(`logs:summary` redaction warnings: 0).

## Dashboard result

`npm.cmd run dashboard:render` regenerates `dashboard/index.html` from the local
logs. The generated `dashboard/index.html` is left unstaged (it is a derived
artifact), and `dashboard/exports/` is gitignored.

## Safety confirmations

- x402 payment attempted: **No**.
- Signing / broadcast: **No**.
- Mainnet used: **No** (Base Sepolia `eip155:84532` only).
- USDT payment rail used: **No** (USDC only).
- Secrets touched / printed: **No** (`.env` untouched; CDP/private-key overrides blank).
- Raw wallet addresses printed: **No** (alias only).
- MongoDB writes performed: **No**.
- RPC called: **No**.
- DeFi Guardian watcher started: **No**.
- Transaction-capable paths (approve/harvest/rebalance/collect/claim/swap/
  bridge/stake/unstake/transfer/send/execute/broadcast): **None invoked**.

## Demo commands

```powershell
cd D:\agentic-payments-lab
npm.cmd run snapshot:refresh:local         # read-only export + validate
npm.cmd run demo:paid-real-local-dry-run   # paid endpoint 402 + buyer dry-run
```

## Next recommended milestone

MVP 002D.1 — Execute exactly one controlled Base Sepolia x402 payment for an
actual sanitized local DeFi Guardian report, **after explicit approval**. This
is intentionally out of scope here: MVP 002D.0 proves the boundary without
attempting payment.
