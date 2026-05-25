# Agentic Payments Lab

Controlled x402 buyer/seller prototypes for paid DeFi intelligence endpoints.

## Status

**MVP 001 — scaffolded.** Direct x402 buyer/seller without Coinbase AWAL.

- Base Sepolia testnet only.
- No real payments yet.
- No real DeFi data yet — the seller returns a mock DeFi Guardian report.
- See [docs/mvp-001-x402-buyer-seller.md](docs/mvp-001-x402-buyer-seller.md) for
  the decision record and why the Coinbase Agentic Wallet bridge is paused.
- See [docs/wallet-bridge-status.md](docs/wallet-bridge-status.md) for the
  prior AWAL diagnosis.

## Layout

```
agentic-payments-lab/
├── package.json              # convenience scripts
├── README.md
├── .gitignore
├── docs/
│   ├── wallet-bridge-status.md
│   └── mvp-001-x402-buyer-seller.md
├── seller-api/               # Express + x402 paid API (TypeScript)
└── buyer-client/             # x402 buyer with --dry-run (TypeScript)
```

## Safety rules

- Testnet only. No mainnet.
- No real private keys. Use a fresh Base Sepolia testnet wallet.
- Buyer **defaults to dry-run** and refuses to sign or pay unless invoked
  with `--pay` (and even then it caps required amount against
  `MAX_PAYMENT_USD`).
- `.env` files are git-ignored. Only `.env.example` is committed.

## Quick start

```bash
# 1. Install
npm run install:all

# 2. Configure seller (testnet receiver only — no mainnet)
cp seller-api/.env.example seller-api/.env
# edit SELLER_RECEIVER_ADDRESS to a Base Sepolia address you own

# 3. Run seller
npm run seller:dev

# 4. In a second terminal: smoke test
curl.exe http://localhost:4021/health
curl.exe -i -X POST http://localhost:4021/paid/defi-risk-report `
  -H "Content-Type: application/json" `
  -d "{\"wallet\":\"0x0000000000000000000000000000000000000000\",\"position\":{\"protocol\":\"pancakeswap\",\"chain\":\"bsc\",\"tokenId\":\"demo-position-001\"}}"
# expect HTTP/1.1 402 Payment Required

# 5. Run buyer in dry-run (prints requirements, never pays)
cp buyer-client/.env.example buyer-client/.env
npm run buyer:dev -- --dry-run
```

The buyer never attempts a real payment unless you explicitly add `--pay`
**and** populate `BUYER_PRIVATE_KEY` with a testnet-only key.
