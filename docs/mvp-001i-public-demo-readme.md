# MVP 001I - Public Demo README / Pitch Flow

## Purpose

MVP 001I produces the public-facing documentation around the existing local
demo. It does not change payment code, does not execute payments, and does
not modify the seller or buyer source.

The goal is to turn the working demo into a clear story that holds up in
front of:

- a GitHub visitor;
- a LinkedIn audience of AI / Web3 / product peers;
- a technical pitch conversation;
- a product or investor conversation.

## Deliverables

- Rewritten root `README.md` aimed at public readers, covering: one-line
  summary, why it matters, what the MVP demonstrates, architecture, current
  demo flow, quickstart, commands, dashboard KPIs, safety model, current
  limitations, roadmap, pitch, and status.
- `docs/public-demo-pitch.md` - a longer grounded pitch (problem, insight,
  demo, what it proves, why x402, why DeFi reports, current state, next
  steps).
- `docs/linkedin-demo-post-draft.md` - two short LinkedIn variants in a
  technical-founder tone.
- This milestone note.

## Positioning Rules Applied

- This is a proof of concept, not a product.
- This is not a trading bot.
- This is not financial advice.
- The default demo does not execute mainnet payments and does not require
  real funds.
- The controlled x402 payment was validated on Base Sepolia testnet only,
  isolated from `demo:local`.
- The current demo uses mock + dry-run paths only.
- Avoided hype words ("revolutionary", "guaranteed revenue", "fully
  autonomous economy"); preferred grounded language ("proof of concept",
  "local demo", "testnet validated", "auditable flow", "pay-per-use API",
  "agent-consumable service").

## Safety Guarantees For This Milestone

This milestone is documentation only. It:

- did not execute any x402 payment;
- did not run `npm.cmd run dev -- --pay`;
- did not use mainnet;
- did not use USDT;
- did not print private keys;
- did not print CDP secrets;
- did not read or modify `D:\defi_guardian`;
- did not read or modify `.env`;
- did not commit secrets;
- did not commit generated runtime logs;
- did not commit generated dashboard exports;
- did not call Coinbase AWAL;
- did not call `make_http_request_with_x402`;
- did not modify x402 payment configuration.

The README and pitch reference the controlled testnet payment that was
already validated in MVP 001B.1 but make clear it is not part of the
default `demo:local` flow.

## Validation

Validation commands run for this milestone:

```powershell
cd D:\agentic-payments-lab

npm.cmd run demo:local
npm.cmd run dashboard:list-exports
npm.cmd run logs:summary

cd D:\agentic-payments-lab\seller-api
npm.cmd run build

cd D:\agentic-payments-lab\buyer-client
npm.cmd run build
```

Results are recorded in the final report alongside the commit hash.

## Next Recommended Milestone

**MVP 001J - Clean demo artifacts, screenshots, and repo hygiene.**

Now that the public-facing story is in place, the next safe step is to
sweep generated artifacts, add screenshots referenced by the README, and
tighten ignored paths so the repo is presentable when shared publicly,
before connecting the real DeFi Guardian engine in MVP 002.
