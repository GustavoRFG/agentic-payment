# TrustForge B.4 — Windows operational mode

B.4 separates **payment core** from **pluggable custody / UX**.

## Payment core (unchanged)

Authority still flows exactly as the golden trace:

```text
fresh unpaid 402
→ exact requirements gate
→ attempt / nonce / unsigned
→ BuyerSigningAuthorization
→ CredentialAccessAuthorization
→ real EIP-3009 signature
→ POST_SIGN_JIT_AUDIT_PASS
→ PaymentSendAuthorization
→ SEND_COMMITTED_NO_RETRY
→ B371 productive one-shot send
→ RESPONSE_OBSERVED
→ ONCHAIN_VERIFIED
```

The thin runner (`thin-mainnet-payment-runner.ts`) cannot bypass PSA derivation
and cannot retry send after `SEND_COMMITTED_NO_RETRY`.

## Pluggable custody

| Mode | Provider | Secret entry |
|---|---|---|
| Legacy / test | `explicit-runtime-key` | TTY or Windows masked dialog + B.3.4 pipe |
| Windows operational | `windows-dpapi-local-signer` | `WINDOWS_DPAPI_VAULT_ONE_SHOT` (no key prompt) |

Checked-in default policy keeps `provider_id=explicit-runtime-key` and
`credential_access_enabled=false`. Operational runs use a run-local policy that
selects the DPAPI provider after vault setup.

## Pluggable UX

- Approve / reject: `windows-approve-reject-dialog` (manual-approve-reject policy)
- One-time vault setup: `trustforge:secure-signer-setup` (masked dialog → DPAPI vault only)

Reject never reaches the signer. Approve yields exact signing + send mandates
sharing one `human_decision_id` — not a bare `authorized=true` flag.

## CLI

- `npm run trustforge:secure-signer-setup` — one-time protect for expected buyer
- `npm run trustforge:mainnet-payment -- --run-dir <path> [--candidate <file>]`

Do not run a real payment without an explicit human Approve and a prepared vault.
