# MVP 006  Base Mainnet x402 Payment Proof

Result:
DISTINCT_RECEIVER_MAINNET_PAYMENT_SUCCEEDED

Flow:
buyer agent
 HTTP 402
 one signed USDC payment request
 CDP Facilitator verify + settlement
 paid Claude analysis
 HTTP 200

Network:
eip155:8453

Asset:
USDC

Amount:
1000 atomic units / 0.001 USDC

Endpoint:
POST /paid/analyze-text

Seller receiver differs from buyer:
Yes

Payment attempts:
1

Payment-bearing HTTP requests:
1

Retry attempted:
No

Claude response received:
Yes

Model:
claude-haiku-4-5-20251001

Token usage:
input 169 / output 196

Latency:
~5.1 seconds

Buyer balance before:
5.677101 USDC

Buyer balance after:
5.676101 USDC

Balance debit:
0.001000 USDC

Secrets printed:
No

Seller stopped:
Yes

Port cleanup:
No LISTENING process on :4021

Meaning:
An AI-agent-compatible buyer paid real USDC on Base mainnet to access a protected
AI analysis endpoint, and the seller released the Claude-generated result only
after successful settlement.

## On-chain proof

Transaction hash:
`0x0b85893d3ac4322f6d5993d622deebf24fae18968d97883d48d738e5d2e4290c`

Block:
`46905982`

Status:
`success`

Token transfer:
`0.001 USDC`

From:
`0xf75d...F392`

To:
`0x2986...fe71`

Verification:
Public Base mainnet ERC-20 settlement confirmed.
