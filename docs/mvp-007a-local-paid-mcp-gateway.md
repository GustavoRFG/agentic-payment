# MVP 007A Local Paid MCP Gateway

## Purpose

MVP 007A exposes the already-proven `POST /paid/analyze-text` x402 endpoint as
local stdio MCP tools for Claude Code and other MCP-compatible agents.

The gateway is intentionally narrow: it adds no new product verticals and does
not change the seller. It defaults to Base Sepolia and blocks mainnet use.

## MCP architecture

```text
Claude Code
  local stdio MCP gateway
  inspect x402 payment requirements without paying
  user explicitly authorizes
  MCP tool calls protected x402 endpoint
  automatic x402 payment handshake
  Claude-powered JSON result returns to Claude Code
```

The gateway runs locally from `mcp-gateway/` and talks to the existing seller at
`RESOURCE_SERVER_URL`, defaulting to `http://localhost:4021`.

## Tools

- `inspect_analyze_text_price` inspects the x402 requirements for
  `/paid/analyze-text` without signing, paying, or printing raw payment headers.
- `analyze_text_paid` requires `confirmation: "PAY_ONCE"`, permits at most one
  controlled Base Sepolia payment attempt, and returns only the paid endpoint's
  sanitized JSON result.

MVP 007A does not execute `analyze_text_paid` during smoke validation.

## Environment

`mcp-gateway/.env.example` documents the local configuration:

```dotenv
RESOURCE_SERVER_URL=http://localhost:4021
BUYER_PRIVATE_KEY=
MAX_PAYMENT_USD=0.001
X402_USE_MAINNET=0
```

Base Sepolia is the default. `X402_USE_MAINNET=1` is rejected by the MCP gateway
for MVP 007A, so no mainnet MCP payment path exists in this sprint.

## Claude Code local install

```powershell
cd D:\agentic-payments-lab

claude mcp remove agentic-paid-tools --scope local 2>$null

claude mcp add --transport stdio --scope local agentic-paid-tools -- `
  npm.cmd --prefix D:\agentic-payments-lab\mcp-gateway run dev
```

Verify:

```powershell
claude mcp list
claude mcp get agentic-paid-tools
```

Expected:

```text
agentic-paid-tools
connected
2 tools
```

## Manual inspect-only demo

Use these Claude Code prompts:

```text
List the tools exposed by agentic-paid-tools.
```

```text
Use inspect_analyze_text_price to check the cost of analyzing:
"AI agents can autonomously purchase specialized API capabilities."

Do not make any payment.
```

The inspect tool should return Base Sepolia USDC requirements for
`/paid/analyze-text`, with `paymentAttempted: false`.

## Paid invocation status

Paid MCP invocation is deferred until explicit approval. The `analyze_text_paid`
tool is present for the next controlled step, but MVP 007A validation only lists
tools and runs the inspect-only path.
