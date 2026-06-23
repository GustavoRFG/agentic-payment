# TrustForge — Phase 6.2B: Facilitator Receipt Capture + Bounded Reconciliation

> **Goal:** capture and preserve the facilitator settlement receipt safely, extract the public transaction hash, cross-check it against the independently reconciled on-chain `Transfer`, bound all RPC work by explicit timeouts, and then perform one final human-authorized Sepolia regression through the shared executor.
>
> **Repository:** `D:\agentic-payments-lab`
>
> **Current branch:** `fix/phase62-binding-provenance` (create a focused child branch)
>
> **Relevant local commits:**
>
> - `16d518d` — shared x402 settlement core promoted from the Sepolia-proven executor
> - `82089a8` — BOM-safe JSON, wallet/network guards, and pre-payment 402 intent checks
> - `40eb7ad` — Phase 6.2 binding false-positive regressions
> - `f5ecb7f` — temporal binding and facilitator-hash semantics repair
>
> **Current honest result:**
>
> ```text
> RESULT: PHASE62_BINDING_TEMPORAL_FIX_PASS_FACILITATOR_RECEIPT_MISSING
> ```
>
> The shared executor has already moved real Sepolia USDC. The missing proof is the facilitator-reported transaction hash required for an independent hash cross-check.

---

## 1. Governing principle

**Capture public settlement proof, never payment secrets.**

The shared executor must capture the response-side facilitator receipt immediately after the wrapped x402 request returns, sanitize it, persist only public settlement metadata, and pass the sanitized receipt into the canonical run-binding layer.

A binding is confirmed only when:

```text
exactly one independent current-window on-chain Transfer exists
AND
facilitator receipt is present and parseable
AND
facilitator tx hash is non-empty
AND
facilitator tx hash == independent on-chain tx hash
```

Missing receipt, malformed receipt, missing hash, ambiguity, or mismatch must never produce `PASS_SETTLED`.

---

## 2. Hard safety rules

1. No mainnet key.
2. No mainnet authorization.
3. No mainnet payment.
4. The agent never loads any private key.
5. The agent never performs a payment-bearing live request.
6. The agent never creates or edits a human authorization decision.
7. Do not reuse consumed authorizations.
8. Do not retry previous settlement runs.
9. Do not run `git stash pop`.
10. No push.
11. Preserve `PAID-001..008` unchanged.
12. Preserve single-shot enforcement unchanged.
13. Preserve wallet-match, chain, asset, payTo, quote, and opposite-key guards.
14. Never persist request-side payment headers or signatures.
15. Persist only sanitized response-side receipt metadata and public blockchain identifiers.
16. Missing receipt is not agreement.
17. Malformed receipt is not agreement.
18. Hash mismatch is not confirmation.
19. RPC timeout must return an honest timeout status.
20. Final live Sepolia regression remains human-executed and exactly one attempt.

At task start:

```powershell
Remove-Item Env:\SEPOLIA_BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue

"SEPOLIA key present? " + [bool]$env:SEPOLIA_BUYER_PRIVATE_KEY
"MAINNET key present? " + [bool]$env:BUYER_PRIVATE_KEY
```

Required:

```text
SEPOLIA key present? False
MAINNET key present? False
```

If either is present, stop.

---

## 3. Branch and baseline

```powershell
cd D:\agentic-payments-lab

Remove-Item -Recurse -Force tests\__pycache__ -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force tools\trustforge\__pycache__ -ErrorAction SilentlyContinue

git status --short
git branch --show-current
git log -5 --oneline
```

Create a focused child branch:

```powershell
git switch -c feat/phase62b-facilitator-receipt
```

Run baseline:

```powershell
npm test
python -m pytest tests -q
```

Expected latest baseline:

```text
406 passed | 1 skipped
21 passed
```

If baseline is red, diagnose before implementation.

---

## 4. Inspect actual installed x402 behavior

Do not assume header names, encoding, or field names from memory.

```powershell
git grep -n -E `
  "payment-response|x-payment-response|PAYMENT-RESPONSE|X-PAYMENT-RESPONSE|settlement.*hash|transaction.*hash" `
  -- buyer-client seller-api tools shared tests node_modules/@x402
```

Inspect installed versions:

```powershell
npm ls @x402/fetch @x402/evm @x402/express
```

Inspect package code and types:

```powershell
Get-ChildItem `
  .\node_modules\@x402,`
  .\seller-api\node_modules\@x402 `
  -Recurse -File -ErrorAction SilentlyContinue |
  Select-String -Pattern `
    'payment-response|x-payment-response|transaction|txHash|transactionHash|settlement' |
  Select-Object Path,LineNumber,Line |
  Format-List
```

Determine and document:

- actual response header name;
- whether `Headers.get()` is sufficient;
- whether payload is JSON, base64, or base64url;
- actual transaction-hash field name;
- whether multiple x402 protocol versions are present;
- whether wrapped fetch preserves the header;
- whether seller middleware exposes settlement data in the body instead;
- whether redirects or middleware can strip receipt headers.

Create:

```text
docs/trustforge-phase62b-facilitator-receipt.md
```

Do not add speculative aliases that are unsupported by observed package behavior.

---

## 5. Dedicated receipt parser and sanitizer

Create:

```text
tools/trustforge/facilitator-settlement-receipt.ts
```

Suggested types:

```ts
export type FacilitatorReceiptSource =
  | "payment-response-header"
  | "x-payment-response-header"
  | "response-body"
  | "none";

export type FacilitatorReceiptParseStatus =
  | "parsed"
  | "missing"
  | "malformed"
  | "unsupported";

export interface SanitizedFacilitatorReceipt {
  readonly parseStatus: FacilitatorReceiptParseStatus;
  readonly source: FacilitatorReceiptSource;
  readonly rawHeaderName: string | null;
  readonly transactionHash: `0x${string}` | null;
  readonly network: string | null;
  readonly payer: string | null;
  readonly payTo: string | null;
  readonly asset: string | null;
  readonly amountAtomic: string | null;
  readonly facilitator: string | null;
  readonly settledAtUtc: string | null;
  readonly parseErrorClass: string | null;
}
```

Suggested API:

```ts
export function extractAndSanitizeFacilitatorReceipt(
  response: Pick<Response, "headers">,
  responseBody?: string,
): SanitizedFacilitatorReceipt;
```

Optional helpers:

```ts
export function decodeReceiptPayload(value: string): unknown;
export function normalizeTransactionHash(value: unknown): `0x${string}` | null;
export function sanitizeReceiptObject(value: unknown): SanitizedFacilitatorReceipt;
```

### Parser requirements

Support the actual installed SDK format and only evidence-backed compatibility forms.

Potential forms, if observed:

1. direct JSON;
2. base64 JSON;
3. base64url JSON;
4. explicit aliases such as:
   - `transaction`
   - `transactionHash`
   - `txHash`
   - `tx_hash`
   - `settlementTxHash`
   - `settlement_tx_hash`
5. known nested forms from installed SDK types.

Do not scan arbitrary unknown strings for a 64-byte value.

A valid tx hash must match:

```ts
/^0x[0-9a-fA-F]{64}$/
```

Normalize for case-insensitive comparison.

Invalid values produce:

```text
transactionHash: null
parseStatus: malformed
```

Never include raw secret-bearing payloads in thrown errors or logs.

---

## 6. Sanitization policy

Allowed fields:

- public tx hash;
- network;
- public payer address;
- public payTo address;
- public token address;
- public amount;
- non-secret facilitator identifier or URL;
- public timestamp;
- response header name;
- parse status;
- error class without raw payload.

Forbidden fields:

- request payment header;
- EIP-3009 authorization signature;
- private key;
- signed authorization bytes;
- bearer/API keys;
- cookies;
- arbitrary raw response payload when it could contain sensitive data.

Persist:

```text
facilitator_receipt_attempt_<attempt_id>.json
```

Parsed example:

```json
{
  "schema_name": "trustforge_facilitator_settlement_receipt",
  "schema_version": "1.0.0",
  "attempt_id": "attempt_...",
  "run_id": "run_...",
  "captured_at_utc": "2026-06-22T...",
  "source": "payment-response-header",
  "parse_status": "parsed",
  "transaction_hash": "0x...",
  "network": "eip155:84532",
  "payer": "0xf75d...",
  "pay_to": "0x29865...",
  "asset": "0x036c...",
  "amount_atomic": "1000",
  "facilitator": "https://x402.org/facilitator",
  "settled_at_utc": null,
  "contains_secret_material": false
}
```

Missing example:

```json
{
  "parse_status": "missing",
  "transaction_hash": null,
  "contains_secret_material": false
}
```

Malformed example:

```json
{
  "parse_status": "malformed",
  "transaction_hash": null,
  "parse_error_class": "INVALID_BASE64_JSON",
  "contains_secret_material": false
}
```

Do not persist malformed raw input.

---

## 7. Capture inside the shared executor

Modify:

```text
tools/trustforge/x402-single-settlement-executor.ts
```

The receipt must be captured immediately after the wrapped x402 request returns and before metadata is discarded.

Target flow:

```text
pre-sign guards
→ intent persistence
→ wrapped x402 fetch
→ response returned
→ capture response headers
→ consume response body once
→ sanitize facilitator receipt
→ persist sanitized receipt
→ return body/status/receipt metadata
```

Requirements:

- `Response.body` is consumed only once;
- rich response body remains available to semantic evaluation;
- headers are not lost in conversion;
- request headers are never persisted;
- capture occurs for HTTP 200, HTTP 402, and other responses when a receipt exists;
- network exceptions return explicit missing-receipt state;
- receipt persistence failure is explicit, never silently treated as captured.

Extend result type:

```ts
export interface SingleSettlementExecutionResult {
  // existing fields...
  readonly responseBody: string;
  readonly responseStatus: number;
  readonly facilitatorReceipt: SanitizedFacilitatorReceipt;
  readonly facilitatorReceiptPath: string;
}
```

Do not alter payment guards or single-shot behavior.

---

## 8. Integrate receipt with canonical binding

Binding input should use the sanitized artifact, not raw logs:

```ts
interface BuildSettlementBindingInput {
  readonly intent: SettlementIntent;
  readonly independentCandidates: readonly NormalizedSettlementCandidate[];
  readonly facilitatorReceipt: SanitizedFacilitatorReceipt;
  readonly classificationStartedAtUtc: string;
}
```

Required statuses:

```ts
type SettlementBindingStatus =
  | "confirmed"
  | "settlement_not_found"
  | "ambiguous_match"
  | "facilitator_receipt_missing"
  | "facilitator_receipt_malformed"
  | "facilitator_hash_missing"
  | "hash_mismatch";
```

Semantics:

| Independent candidates | Receipt | Hash | Result |
|---:|---|---|---|
| 0 | any | any | `settlement_not_found` |
| >1 | any | any | `ambiguous_match` |
| 1 | missing | none | `facilitator_receipt_missing` |
| 1 | malformed | none | `facilitator_receipt_malformed` |
| 1 | parsed | missing | `facilitator_hash_missing` |
| 1 | parsed | different | `hash_mismatch` |
| 1 | parsed | equal | `confirmed` |

No other state may produce `confirmed`.

If the legacy boolean remains:

```ts
facilitator_hash_agrees =
  status === "confirmed" ? true :
  status === "hash_mismatch" ? false :
  null;
```

---

## 9. Binding artifact schema

Confirmed example:

```json
{
  "attempt_id": "attempt_...",
  "run_id": "run_...",
  "authorization_hash": "...",
  "settlement_status": "confirmed",
  "independent_match": {
    "settlement_tx_hash": "0x...",
    "block_number": 43199999,
    "timestamp_utc": "2026-06-22T...",
    "actual_spend_atomic": "1000"
  },
  "facilitator_receipt": {
    "source": "payment-response-header",
    "parse_status": "parsed",
    "transaction_hash": "0x..."
  },
  "facilitator_hash_cross_check": "agree",
  "facilitator_hash_agrees": true,
  "matched_by": [
    "network",
    "buyer",
    "pay_to",
    "asset",
    "amount",
    "time_window"
  ]
}
```

Missing receipt:

```json
{
  "settlement_status": "facilitator_receipt_missing",
  "facilitator_hash_cross_check": "missing",
  "facilitator_hash_agrees": null
}
```

Malformed receipt:

```json
{
  "settlement_status": "facilitator_receipt_malformed",
  "facilitator_hash_cross_check": "missing",
  "facilitator_hash_agrees": null
}
```

Mismatch:

```json
{
  "settlement_status": "hash_mismatch",
  "facilitator_hash_cross_check": "mismatch",
  "facilitator_hash_agrees": false
}
```

---

## 10. Classification policy

`PASS_SETTLED` requires all:

1. exactly one payment attempt;
2. exactly one independent current-window on-chain match;
3. balance identity pass;
4. receipt parse status `parsed`;
5. facilitator tx hash present;
6. facilitator tx hash equals independent tx hash;
7. attempt ID and authorization hash match;
8. no current-run ambiguity;
9. no secret leakage;
10. strict no-mainnet.

Honest non-pass statuses:

```text
SETTLED_ONCHAIN_FACILITATOR_RECEIPT_MISSING
SETTLED_ONCHAIN_FACILITATOR_RECEIPT_MALFORMED
SETTLED_ONCHAIN_FACILITATOR_HASH_MISSING
FAIL_SETTLEMENT_HASH_MISMATCH
RECONCILIATION_RPC_TIMEOUT
```

Never emit `PASS_SETTLED` without strict hash cross-check.

---

## 11. Unit tests — receipt parser

Create:

```text
tests/unit/trustforge-facilitator-settlement-receipt.test.ts
```

Required tests:

### Header lookup

- `payment-response` found;
- normal HTTP header casing works through `Headers`;
- `x-payment-response` found when supported;
- no header returns `missing`;
- precedence is deterministic.

### Encodings

When supported by actual SDK behavior:

- direct JSON;
- base64 JSON;
- base64url JSON;
- padded base64;
- unpadded base64url;
- malformed base64;
- decoded invalid JSON;
- valid JSON without recognized tx field.

### Hash aliases

Test every explicitly supported alias.

### Validation

- valid hash accepted;
- uppercase normalized;
- missing prefix rejected unless policy explicitly normalizes it;
- short, long, or non-hex rejected;
- arbitrary nested strings ignored.

### Sanitization

Output must not contain:

- authorization;
- signature;
- request payment header;
- private key;
- cookie;
- API key.

Malformed input returns a typed safe result without raw payload leakage.

---

## 12. Shared executor tests

Extend:

```text
tests/unit/trustforge-x402-single-settlement-executor.test.ts
```

Using mocked `fetch`/`Response`, test:

1. HTTP 200 with valid receipt:
   - parsed;
   - sanitized artifact written;
   - tx hash returned;
   - no request payment header persisted.

2. HTTP 200 without receipt:
   - artifact says missing;
   - no false agreement.

3. HTTP 200 malformed receipt:
   - artifact says malformed;
   - raw value absent.

4. HTTP 402 with receipt:
   - capture still occurs;
   - payment-bearing count remains accurate.

5. Body consumed once:
   - rich response body remains available.

6. Persistence failure:
   - explicit failure state;
   - no silent success.

7. Artifact contains public identifiers only.

---

## 13. Binding tests

Extend:

```text
tests/unit/trustforge-settlement-run-binding.test.ts
```

Test full matrix:

| Independent match | Receipt | Hash relation | Expected |
|---|---|---|---|
| none | parsed | n/a | `settlement_not_found` |
| ambiguous | parsed | n/a | `ambiguous_match` |
| one | missing | n/a | `facilitator_receipt_missing` |
| one | malformed | n/a | `facilitator_receipt_malformed` |
| one | parsed/no hash | n/a | `facilitator_hash_missing` |
| one | parsed/hash | mismatch | `hash_mismatch` |
| one | parsed/hash | equal | `confirmed` |

Assert:

- only confirmed gives `true`;
- mismatch gives `false`;
- missing/malformed/no hash gives `null`;
- only current-attempt binding supplies final result hash;
- historical settlement cannot leak into current result.

---

## 14. Rich-orchestration regression

The mainnet Phase 6 wrapper must still receive:

- response body;
- response status;
- receipt metadata;
- payment-bearing count;
- no secret-bearing request metadata.

Receipt capture must not alter:

```text
semantic evaluation
seller response parsing
PAID-001..008
single-shot
authorization consumption
```

Run all existing rich tests unchanged. If any invariant changes behavior, stop and report.

---

## 15. Bounded RPC reconciliation

The previous classifier hung for approximately 90 minutes. This must become impossible.

Add explicit controls:

```text
--rpc-request-timeout-seconds 20
--rpc-max-retries 2
--max-total-runtime-seconds 180
```

Equivalent environment variables may exist, but CLI must be explicit and testable.

Required behavior:

```text
individual RPC timeout → bounded retry
global deadline exceeded → terminate honestly
```

Output:

```text
reconciliation_status: RECONCILIATION_RPC_TIMEOUT
safe_to_use_for_payment_verification: false
```

Do not misclassify timeout as settlement not found.

### TypeScript child-process timeout

If spawning the Python reconciler:

- enforce process timeout;
- terminate child on deadline;
- capture timeout class;
- avoid orphan process;
- never claim reconciliation complete.

### Tests

- request timeout;
- retry count;
- global deadline;
- child killed;
- honest timeout status;
- incomplete reconciliation cannot confirm binding.

---

## 16. Harden `--reuse-existing-ledger`

Before offline reuse, validate:

- network;
- chain ID;
- buyer;
- asset;
- ledger schema version;
- generation timestamp;
- scanned block range;
- SHA-256 when manifest exists;
- run/source metadata when available.

Suggested metadata:

```json
{
  "ledger_sha256": "...",
  "network": "eip155:84532",
  "chain_id": 84532,
  "buyer": "0xf75d...",
  "asset": "0x036c...",
  "generated_at_utc": "...",
  "scanned_from_block": 43100000,
  "scanned_to_block": 43199999
}
```

Mismatch result:

```text
REUSE_LEDGER_IDENTITY_MISMATCH
```

Tests:

- exact identity passes;
- wrong wallet refuses;
- wrong chain refuses;
- wrong asset refuses;
- malformed ledger refuses;
- unsupported schema refuses or migrates explicitly;
- manifest hash mismatch refuses.

---

## 17. Documentation

Create/update:

```text
docs/trustforge-phase62b-facilitator-receipt.md
```

Document:

- installed x402 version;
- actual receipt header;
- encoding;
- tx hash field;
- sanitization policy;
- binding states;
- timeout policy;
- offline ledger reuse policy;
- final human live-run procedure;
- strict no-mainnet rule.

Do not claim milestone completion before the live regression.

---

## 18. Validation before live payment

```powershell
npx vitest run `
  tests/unit/trustforge-facilitator-settlement-receipt.test.ts `
  tests/unit/trustforge-x402-single-settlement-executor.test.ts `
  tests/unit/trustforge-settlement-run-binding.test.ts `
  tests/unit/trustforge-sepolia-settlement.test.ts `
  tests/unit/trustforge-phase6-1-hardening.test.ts `
  tests/unit/trustforge-phase6-authorization.test.ts `
  tests/unit/trustforge-rich-tx-explainer-orchestrator.test.ts `
  --reporter=verbose

npm test
python -m pytest tests -q
git diff --check
git status --short
```

Requirements:

- full suite no lower than current baseline;
- new tests increase count;
- reconciler suite green;
- no skipped new safety test;
- no secret leakage;
- no key loaded;
- no payment.

Check centralization:

```powershell
git grep -n -E `
  "privateKeyToAccount|wrapFetchWithPayment|registerExactEvmScheme|new x402Client" `
  -- tools
```

Money-moving primitives must remain centralized.

---

## 19. Local commit policy

Suggested commits:

```text
feat: capture and sanitize facilitator settlement receipts
test: add facilitator receipt parsing and binding matrix
fix: bound RPC reconciliation and validate offline ledger reuse
docs: document Phase 6.2B receipt and timeout policy
```

No push.

---

## 20. Pre-live agent result

Before human execution, print:

```text
RESULT: PHASE62B_READY_FOR_HUMAN_SEPOLIA_REGRESSION

Receipt capture:
  implemented in shared executor

Sanitization:
  request payment headers and signatures excluded

Binding:
  strict receipt/hash states implemented

RPC:
  request timeout, retry limit, and global deadline implemented

Offline classification:
  ledger identity validated

Mainnet:
  blocked

Keys:
  none loaded

Payments:
  none executed by agent

Tests:
  <count> passed | <skipped>
  <python count> passed

Commits:
  <local commits>

Push:
  no
```

Only then proceed to the human step.

---

# Human-executed final Sepolia regression

The following steps are human-only.

## 21. Fresh run

Start seller in a dedicated terminal:

```powershell
cd D:\agentic-payments-lab\seller-api
npm run dev
```

In another terminal:

```powershell
cd D:\agentic-payments-lab
Test-NetConnection localhost -Port 4021 -InformationLevel Quiet
```

Must be `True`.

Create a fresh run:

```powershell
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$run = "D:\trustforge\artifacts\runs\sepolia-settlement-proof\run_$stamp"

$run
Test-Path $run
```

Must initially be `False`.

Bootstrap:

```powershell
node .\seller-api\node_modules\tsx\dist\cli.mjs `
  .\tools\run-trustforge-sepolia-bootstrap.ts `
  --run-dir `
  "$run"
```

Require:

```text
READY_FOR_HUMAN_AUTH
network: eip155:84532
quote_usdc: 0.001
agent_signed: no
```

---

## 22. New human authorization

Create a new `human_payment_authorization.json` from the generated draft.

Required:

```text
decision: authorize_one_payment
network: eip155:84532
buyer_wallet: 0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392
endpoint: http://localhost:4021/paid/analyze-text
max_payment_attempts: 1
allow_retry: false
max_usdc: approved cap covering 0.001 quote
```

Never reuse a prior authorization.

---

## 23. Preflight without key

```powershell
node .\seller-api\node_modules\tsx\dist\cli.mjs `
  .\tools\run-trustforge-sepolia-preflight.ts `
  --run-dir `
  "$run"
```

Require:

```text
PASS
chain_id: 84532
seller handshake: live
mainnet key absent
strict_no_mainnet: yes
```

---

## 24. Human loads only Sepolia key

Use the established safe loading process.

Required:

```text
SEPOLIA key present? True
MAINNET key present? False
```

Derive and verify public address:

```text
0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392
```

Never print the key.

---

## 25. Exactly one settlement attempt

```powershell
node .\seller-api\node_modules\tsx\dist\cli.mjs `
  .\tools\run-trustforge-sepolia-settlement-probe.ts `
  --run-dir `
  "$run"
```

Never rerun, whatever the result.

Immediately remove both key environment variables.

---

## 26. Classify with bounded RPC

```powershell
node .\seller-api\node_modules\tsx\dist\cli.mjs `
  .\tools\run-trustforge-sepolia-classify.ts `
  --run-dir `
  "$run" `
  --rpc-request-timeout-seconds 20 `
  --rpc-max-retries 2 `
  --max-total-runtime-seconds 180
```

If RPC fails honestly, reuse an existing ledger only after identity/integrity checks pass.

---

## 27. Final acceptance criteria

All must be present:

```text
payment_attempted: yes
payment_bearing_http_request_count: 1
single_shot: yes
http_status: 200

facilitator_receipt_parse_status: parsed
facilitator_receipt_source: observed valid response source
facilitator_transaction_hash: 0x...

current_attempt_candidates_after_filter: 1
known_settlements_confirmed_onchain: 1
phase6_settlements_identified: 1
unattributed_settlements_found: 0

binding_status: confirmed
facilitator_hash_agrees: true
independent_transaction_hash: 0x...
facilitator_transaction_hash: same 0x...
balance_identity_status: pass
actual_spend_usdc: 0.001

agent_signed: no
strict_no_mainnet: yes
secrets_printed: no
```

The receipt artifact must contain no secret material.

---

## 28. Final result

Only after the final live run passes:

```text
RESULT: PHASE62_SHARED_EXECUTOR_PROVEN

Shared core:
  used by Sepolia and mainnet Phase 6 settlement core

Live Sepolia:
  one new human-authorized 0.001 USDC settlement

Receipt:
  captured and sanitized

Independent verification:
  on-chain Transfer found in current intent window

Hash cross-check:
  facilitator hash == independent RPC hash

Binding:
  current attempt 1/1
  confirmed
  no ambiguity
  no unattributed current settlement

RPC:
  bounded by request and total timeouts

Safety:
  no mainnet key
  no mainnet authorization
  no mainnet payment
  no push
```

Alternative honest results:

```text
RESULT: PHASE62B_LIVE_SETTLEMENT_RECEIPT_STILL_MISSING
RESULT: PHASE62B_LIVE_SETTLEMENT_HASH_MISMATCH
RESULT: PHASE62B_RECONCILIATION_RPC_TIMEOUT
```

No automatic retry and no second payment.

---

## 29. Definition of done

### Code and tests

```text
[ ] Actual installed x402 receipt format documented
[ ] Dedicated receipt parser implemented
[ ] Receipt capture occurs inside shared executor
[ ] Response body remains available to rich orchestration
[ ] Sanitized receipt artifact persisted
[ ] Request payment headers never persisted
[ ] Missing receipt is not agreement
[ ] Malformed receipt is not agreement
[ ] Missing hash is not agreement
[ ] Hash mismatch is not confirmed
[ ] Binding consumes sanitized receipt artifact
[ ] RPC request timeout implemented
[ ] RPC total runtime deadline implemented
[ ] Child process cannot hang indefinitely
[ ] Offline ledger reuse validates identity/integrity
[ ] PAID-001..008 green
[ ] Full TypeScript suite green
[ ] Python reconciler suite green
[ ] No mainnet action
[ ] No key loaded by agent
[ ] No payment executed by agent
[ ] No push
```

### Final live proof

```text
[ ] New Sepolia authorization
[ ] Exactly one attempt
[ ] Receipt parsed
[ ] Facilitator tx hash present
[ ] Independent current-window Transfer found
[ ] Hashes equal
[ ] Binding confirmed 1/1
[ ] Balance delta == 0.001 USDC
[ ] No secrets
[ ] Mainnet remains blocked pending separate human authorization
```

---

## 30. Autonomous agent execution style

The agent completes all non-payment work in one loop:

```text
inspect installed SDK
→ characterize receipt format
→ write parser tests
→ implement sanitizer
→ integrate shared executor
→ integrate binding
→ add RPC deadlines
→ harden offline ledger reuse
→ run focused tests
→ run full tests
→ fix remaining issues
→ document
→ commit locally
→ print PHASE62B_READY_FOR_HUMAN_SEPOLIA_REGRESSION
```

Do not pause for routine confirmation.

Stop only for:

- loading a private key;
- executing a payment;
- creating human authorization;
- mainnet action;
- destructive evidence mutation;
- an SDK behavior that genuinely cannot be determined from installed code and tests without a live paid request.

The final paid regression remains human-only.
