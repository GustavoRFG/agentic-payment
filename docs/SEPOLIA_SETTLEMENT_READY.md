# Base Sepolia settlement ready — single-shot proof

**Status:** `SEPOLIA_SETTLEMENT_READY_HUMAN_GATE`  
**Agent does not load `SEPOLIA_BUYER_PRIVATE_KEY` or `BUYER_PRIVATE_KEY`.**

## Testnet wallet

| Field | Value |
|---|---|
| Wallet | `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392` |
| Network | `eip155:84532` (Base Sepolia) |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| Key env | `SEPOLIA_BUYER_PRIVATE_KEY` only |
| Mainnet key | `BUYER_PRIVATE_KEY` must be **absent** |

## Agent workflow (no keys)

```powershell
cd D:\agentic-payments-lab
Remove-Item Env:\BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue
npm run trustforge:sepolia:preflight
npm run trustforge:sepolia:bootstrap -- --run-dir "D:/trustforge/artifacts/runs/sepolia-settlement-proof/<run_id>"
```

Use forward slashes in `--run-dir` paths on Windows (backslashes can break parsing).

1. Start seller-api on Base Sepolia (`X402_NETWORK=eip155:84532`, no `X402_USE_MAINNET`).
2. Preflight confirms RPC `84532`, wallet ETH+USDC, seller `402`.
3. Bootstrap writes `target_selection.json`, `selected_candidate.json`, `human_payment_authorization.DRAFT.json`, freshness preflight.

## Human authorization

1. Rename `human_payment_authorization.DRAFT.json` → `human_payment_authorization.json`
2. Set `decision: "authorize_one_payment"`, fill `rationale`, set `decided_at`
3. Confirm `network: "eip155:84532"`, `buyer_wallet: "0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392"`
4. Commit authorization in the run directory

## Human executes exactly one settlement

```powershell
cd D:\agentic-payments-lab
Remove-Item Env:\BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue
# Human only: load SEPOLIA_BUYER_PRIVATE_KEY for 0xf75d...F392
$env:SEPOLIA_BUYER_PRIVATE_KEY = "<human testnet key>"
npm run trustforge:sepolia:settle -- --run-dir "D:\trustforge\artifacts\runs\sepolia-settlement-proof\<run_id>"
```

Pre-sign guards (in code):

- Resolved address == `0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392`
- Network == `eip155:84532`
- `BUYER_PRIVATE_KEY` absent
- Single attempt, no retry, no fallback

## Agent classify (read-only, after human settlement)

```powershell
Remove-Item Env:\BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\SEPOLIA_BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue
npm run trustforge:sepolia:classify -- --run-dir "D:\trustforge\artifacts\runs\sepolia-settlement-proof\<run_id>"
```

Success requires **`PASS_SETTLED`**:

- Exactly one Sepolia USDC `Transfer` to seller `payTo` for authorized quote
- Balance delta == quote
- `safe_to_use_for_payment_verification: yes` on Sepolia reconciler

`PASS_NO_SETTLE_CLEAN` here means the happy path is **not** proven — stop, do not retry-grind.

## RPC configuration

```powershell
$env:TRUSTFORGE_SEPOLIA_RPC_URL = "https://sepolia.base.org"
```

## Safety

- Testnet only — mainnet `8453` hard-refused at every gate
- Agent never signs
- No push from agent commits
