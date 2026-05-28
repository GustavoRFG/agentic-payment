# Public Demo Checklist

## Before recording or presenting

- [ ] Run `git status --short`.
- [ ] Confirm no `.env`, `secrets/`, `logs/`, or `dashboard/exports/` are staged.
- [ ] Run `npm.cmd run demo:local`.
- [ ] Run `npm.cmd run dashboard:open`.
- [ ] Confirm the dashboard shows `Errors = 0`.
- [ ] Confirm `x402 payment attempted: No` in the demo output.
- [ ] Confirm no private keys, CDP secrets, raw x402 signatures, or raw payment
      headers are visible.
- [ ] Optionally refresh screenshots
      (see [screenshots/README.md](screenshots/README.md)).

## Demo script

1. Show the README one-line summary.
2. Run `npm.cmd run demo:local`.
3. Open the dashboard (`npm.cmd run dashboard:open`).
4. Explain HTTP 402 offers, dry-run requests, reports generated, and the
   correlated buyer/seller request IDs.
5. Open [public-demo-pitch.md](public-demo-pitch.md).
6. Explain the roadmap toward real DeFi Guardian integration (MVP 002).

## Safety statement

The public demo does not execute a payment. The controlled x402 payment was
validated separately on the Base Sepolia testnet, isolated from the default
`demo:local` flow. The demo never touches mainnet and never moves USDT.
