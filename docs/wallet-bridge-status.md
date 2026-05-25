# Coinbase Agentic Wallet / AWAL bridge status

Date: 2026-05-25
Project: Agentic Payments Lab
Experiment: DeFi Guardian Paid API via x402

## Result

RESULT: BLOCKED_WALLET_BRIDGE

`payments-mcp` is installed and Claude Code can connect to the MCP server, but AWAL wallet operations still fail because the wallet UI/service bridge does not return responses on this Windows environment.

No payment was attempted.

## Environment

- OS: Windows
- Workspace: `D:\agentic-payments-lab`
- Node: `C:\nvm4w\nodejs\node.exe`, `v24.15.0`
- npm: `11.6.2`
- Claude Code: `C:\Users\admin\.local\bin\claude.exe`
- payments-mcp install path: `C:\Users\admin\.payments-mcp`
- payments-mcp version: `2.11.0`
- AWAL package tested: `awal@2.10.0`
- Debug backup: `D:\agentic-payments-lab\debug\wallet-timeout-20260525-004223`

## Official behavior expected

Coinbase documentation describes these read-only or auth commands as supported by AWAL:

- `npx awal status`
- `npx awal auth login <email>`
- `npx awal auth verify <flowId> <otp>`
- `npx awal address`
- `npx awal balance [--chain]`

The MCP quickstart says first-time setup opens the wallet UI from the MCP client, and the sign-in-status tool reports the authenticated email and wallet address when signed in.

References:

- https://docs.cdp.coinbase.com/agentic-wallet/cli/quickstart
- https://docs.cdp.coinbase.com/agentic-wallet/mcp/quickstart
- https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/check-sign-in-status
- https://docs.cdp.coinbase.com/agentic-wallet/mcp/mcp-tools/show-wallet-app
- https://github.com/coinbase/payments-mcp

## What works

- `payments-mcp` installer status is healthy:
  - installed at `C:\Users\admin\.payments-mcp`
  - local version `2.11.0`
  - remote version `2.11.0`
  - installation is up to date
- Claude Code MCP list reports:

```text
payments-mcp: C:\nvm4w\nodejs\node.exe --import file:///D:/agentic-payments-lab/mcp/register-electron-stub.mjs D:/agentic-payments-lab/mcp/payments-mcp-node-stdio.mjs - ✓ Connected
```

## Key local findings

- The previous Electron stub is enough for MCP startup and tool listing, but it does not create a real renderer/UI bridge.
- AWAL uses filesystem IPC, not a localhost port:
  - lock: `/tmp/payments-mcp-ui.lock`
  - requests: `/tmp/payments-mcp-ui-bridge/requests`
  - responses: `/tmp/payments-mcp-ui-bridge/responses`
- On Windows, Node maps `/tmp` to the current drive. From `D:\agentic-payments-lab`, the active paths are:
  - `D:\tmp\payments-mcp-ui.lock`
  - `D:\tmp\payments-mcp-ui-bridge\requests`
  - `D:\tmp\payments-mcp-ui-bridge\responses`
- AWAL standalone state/server path is:
  - `C:\Users\admin\AppData\Local\awal-nodejs\Data\server`
- AWAL server auto-start fails locally with:

```text
Failed to start server: spawn EINVAL
Bridge communication error: Failed to start wallet. Please start it manually.
```

## Commands tested

Snapshot and package checks:

```powershell
node -v
npm -v
& "$env:USERPROFILE\.local\bin\claude.exe" mcp list
npx.cmd --yes @coinbase/payments-mcp status
npx.cmd --yes awal --help
npx.cmd --yes awal auth --help
npm.cmd view awal version dist-tags bin main
npm.cmd view @coinbase/payments-mcp version dist-tags bin main
```

Bridge/process checks:

```powershell
Get-Process node,electron -ErrorAction SilentlyContinue
netstat -ano
Get-ChildItem D:\tmp\payments-mcp-ui-bridge -Recurse -Force
```

Manual real Electron launch attempts:

```powershell
& "C:\Users\admin\.payments-mcp\node_modules\electron\dist\electron.exe" `
  --no-sandbox `
  --user-data-dir="D:\agentic-payments-lab\.wallet-electron-user-data-4" `
  "C:\Users\admin\.payments-mcp\bundle-electron.js"
```

```powershell
& "C:\Users\admin\AppData\Local\awal-nodejs\Data\server\node_modules\electron\dist\electron.exe" `
  --no-sandbox `
  --user-data-dir="D:\agentic-payments-lab\.awal-electron-user-data" `
  "C:\Users\admin\AppData\Local\awal-nodejs\Data\server\bundle-electron.js"
```

AWAL read-only/auth tests:

```powershell
node "$env:LOCALAPPDATA\npm-cache\_npx\add7b966af04a3a1\node_modules\awal\dist\index.js" status --json
node "$env:LOCALAPPDATA\npm-cache\_npx\add7b966af04a3a1\node_modules\awal\dist\index.js" auth login guxgomes@gmail.com --json
```

## Exact failures observed

Against a manually running real AWAL Electron process, `status --json` waited for the AWAL default bridge timeout and failed:

```text
× Failed to check status
Request timed out. The wallet may be unresponsive.

Try:
  1. Check if the wallet is still running: npx awal status
  2. Restart the wallet and try again
```

The Electron UI logged that the Coinbase web app loaded, including auth state refresh messages, but no CLI response was written back through the bridge.

When the CLI tried to auto-start the standalone AWAL server, it failed immediately:

```text
Failed to start server: spawn EINVAL
× Failed to send verification code
Bridge communication error: Failed to start wallet. Please start it manually.

This may indicate a configuration issue. Try restarting the wallet.
```

Earlier Claude Code wallet address lookup also timed out after 3 minutes:

```text
The wallet address lookup timed out - the UI bridge didn't respond after 3 minutes.
```

## Interpretation

The MCP connection problem is fixed, but wallet operations are still blocked below the MCP layer.

There are two separate Windows bridge issues:

1. The stubbed MCP wrapper makes `payments-mcp` connect, but it intentionally bypasses the real Electron renderer/UI bridge. Wallet address, balance, auth, and status calls need that bridge.
2. The real AWAL/Electron path can be started manually only with extra Electron flags, but the AWAL CLI still does not receive responses through the filesystem bridge. The packaged AWAL auto-start path also fails with `spawn EINVAL` on this Windows setup.

This is most likely a Coinbase AWAL / payments-mcp Windows Electron bridge issue, not an x402 protocol issue and not a Claude MCP registration issue.

## Current workaround status

Keep the current MCP wrapper only for non-wallet MCP connectivity and non-payment discovery experiments. Do not treat it as a working wallet bridge.

Do not call paid x402 endpoints from this setup until wallet status, address, balance, and spending limits can be verified through a working wallet path.

## Recommended fallback

Continue Agentic Payments Lab without depending on Coinbase Agentic Wallet UI for now:

1. Build `seller-api` with x402 middleware and a mock `/paid/defi-risk-report`.
2. Build `buyer-client` using official x402 buyer libraries.
3. Use testnet/local configuration and explicit `maxAmount` limits.
4. Keep all payments disabled until the buyer path is intentionally enabled.
5. Revisit Coinbase AWAL when the Windows bridge is fixed or when testing under Linux, WSL, or macOS.

