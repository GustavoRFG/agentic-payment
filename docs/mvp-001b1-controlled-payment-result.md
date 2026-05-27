# MVP 001B.1 - Controlled Base Sepolia Payment Result

Date: 2026-05-26

Branch: `mvp-001b1-controlled-payment`

Commit before test: `9dbb5532997147bd209c55d7efed7de0ce3a33b3`

## Scope

This phase was intended to execute one controlled x402 payment on Base Sepolia
only after readiness checks, wallet configuration, and testnet funding were
confirmed.

The initial 2026-05-26 run did not execute a payment. Later sections record
the CDP ETH funding update and the 2026-05-27 controlled paid test.

## Local wallet setup update

Fresh testnet wallet generated for Base Sepolia only.

Local `.env` files created but not committed:

- `buyer-client/.env`
- `seller-api/.env`

Buyer address: `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`

Seller receiver address: `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`

Wallet funding still required:

- Base Sepolia ETH for gas is missing.
- Base Sepolia USDC is missing.

## Network, asset, and amount

- Network: Base Sepolia
- CAIP-2: `eip155:84532`
- Asset: USDC on Base Sepolia
- Amount: `0.001 USDC`
- Atomic amount: `1000`
- Paid endpoint: `POST http://localhost:4021/paid/defi-risk-report`

## Wallet readiness result

`buyer-client/.env` was not present locally, so no fresh testnet-only
`BUYER_PRIVATE_KEY` was configured for this run.

Because the buyer key was absent:

- buyer address could not be derived;
- Base Sepolia ETH balance could not be checked;
- Base Sepolia USDC balance could not be checked;
- payment execution was blocked before any signing path.

The repository now includes a read-only wallet preflight command for the next
attempt:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run wallet:check
```

The script derives the buyer address, checks Base Sepolia ETH, checks Base
Sepolia USDC, and never prints the private key.

## Dry-run result

Not executed in this blocked run because the required local `.env` files were
absent. The previous MVP 001B.0 validation already proved the dry-run path with
the local seller and HTTP 402 requirements.

Before a future payment attempt, rerun:

```powershell
cd D:\agentic-payments-lab\buyer-client
npm.cmd run payment:check
npm.cmd run wallet:check
npm.cmd run dev -- --dry-run
```

## Initial payment execution result

Blocked. No payment was attempted.

Reason:

```text
buyer-client/.env missing; no fresh testnet-only BUYER_PRIVATE_KEY configured.
```

## Paid report result

No paid report was returned in this run because payment execution was blocked.

## CDP Faucet attempt status

Date: 2026-05-27

Current buyer address:
`0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`

Latest wallet preflight:

- Base Sepolia USDC is already funded: `20 USDC`.
- Base Sepolia ETH is still missing: `0 ETH`.
- USDC status: pass.
- ETH status: missing Base Sepolia ETH for gas.
- Payment execution: not performed by the wallet check script.

Faucet route decision:

- Alchemy, QuickNode, Chainstack, and thirdweb faucets were rejected for this
  cycle because the task scope forbids those providers.
- CDP Faucet was investigated using official Coinbase Developer Platform docs.
- The TypeScript SDK route uses `@coinbase/cdp-sdk`.
- The REST route is `POST https://api.cdp.coinbase.com/platform/v2/evm/faucet`.
- The exact EVM faucet network name for Base Sepolia is `base-sepolia`.
- The exact native ETH token value is `eth`.
- CDP docs state that an external wallet address can be supplied directly to
  `cdp.evm.requestFaucet({ address, network: "base-sepolia", token: "eth" })`;
  it is not limited to CDP-created accounts.
- Programmatic use requires a CDP account, `CDP_API_KEY_ID`,
  `CDP_API_KEY_SECRET`, and `CDP_WALLET_SECRET`.
- No local CDP credentials were present in the current process,
  `buyer-client/.env`, or `seller-api/.env`.
- Because credentials were missing, no CDP Faucet request was attempted.

Safety confirmations for this CDP Faucet investigation:

- No mainnet was used.
- No USDT was used.
- No X/Twitter connection was used.
- No real funds were used.
- No private key or API secret was printed.
- No payment was attempted.

## CDP Faucet ETH funding succeeded

Date: 2026-05-27

CDP Faucet sent Base Sepolia ETH to the external buyer address.

- Transaction hash:
  `0xb26bc526ae3c846a012b6764da24df61eb7d21e77f87f477bb7f54e54ea009d3`
- Target address: `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`
- Network: Base Sepolia (`eip155:84532`)
- Faucet token: ETH
- ETH status: pass
- USDC status: pass
- No x402 payment attempted yet.
- Secrets were not printed.
- Secrets were not committed.

## Controlled x402 payment succeeded

Date: 2026-05-27

Exactly one controlled x402 payment attempt was executed on Base Sepolia after
final readiness checks and a final dry-run.

Final pre-payment checks:

- `payment:check`: pass
- `wallet:check`: pass
- ETH status: pass
- USDC status: pass

Final dry-run requirements:

- Network: `eip155:84532`
- Asset: Base Sepolia USDC
- Amount: `1000` atomic units (`0.001 USDC` / `$0.001`)
- Receiver: `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`
- Dry-run result: HTTP 402 detected and no payment attempted.

Payment execution result:

- Command: `npm.cmd run dev -- --pay`
- Payment attempts: 1
- Final response: HTTP 200
- Transaction hash: not available in the captured buyer or seller output
- Paid report returned: yes

Paid report summary:

```json
{
  "reportId": "mock-report-001",
  "mode": "mock",
  "riskLevel": "medium",
  "rangeStatus": "in_range",
  "recommendation": "hold"
}
```

Safety confirmations for the paid run:

- No mainnet was used.
- No USDT was used.
- Private key was not printed.
- CDP secrets were not printed.

## Safety confirmations

- No mainnet funds were used.
- No USDT was used.
- No private key was printed.
- No `.env` file was committed.
- No Coinbase AWAL / Agentic Wallet UI path was used.
- `make_http_request_with_x402` was not used.

## Required next setup

Create or provide a fresh testnet-only wallet that has never held mainnet
funds, then fund it with:

- Base Sepolia ETH for gas;
- at least `0.001` Base Sepolia USDC for payment.

Then create local ignored files:

- `seller-api/.env`
- `buyer-client/.env`

Do not commit those files.
