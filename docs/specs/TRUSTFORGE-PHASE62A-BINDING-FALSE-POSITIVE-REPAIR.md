# TrustForge — Phase 6.2A: Binding False-Positive Repair and Read-Only Reclassification

> **Purpose:** fix the canonical run-binding defect discovered after the live Phase 6.2 Sepolia regression, add the complete regression matrix in one agent pass, and reclassify the already-existing settlement **without making another payment**.
>
> **Repository:** `D:\agentic-payments-lab`  
> **Current branch:** `feat/bazaar-target-discovery` (create a focused child branch)  
> **Relevant landed commits:**  
> - `16d518d` — promoted Sepolia-proven executor as shared core  
> - `82089a8` — BOM-safe JSON, wallet/network guards, and pre-payment 402 intent checks
>
> **Critical rule:** this task is code, tests, artifact inspection, read-only RPC reconciliation, and classification only. It must never load a private key, execute a payment-bearing request, reuse an authorization, or touch mainnet.

---

## 1. Executive diagnosis

The live shared-executor regression moved a second real `0.001 USDC` payment on Base Sepolia:

- run: `D:\trustforge\artifacts\runs\sepolia-settlement-proof\run_20260621_212429`
- attempt: `attempt_8e1a854c-c841-47b9-937c-5549857484a5`
- authorization hash: `a6ab2d6b518734e807515e99fb816c1c6669759a1f030693b6ec87cc4d6a1a03`
- intent start: `2026-06-22T00:26:14.368Z`
- buyer: `0xf75d6b83d366a6e9fc2fb8bf113d67050c44f392`
- payTo: `0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71`
- asset: `0x036cbd53842c5426634e7929541ec2318f3dcf7e`
- amount: `1000` atomic = `0.001 USDC`
- preflight balance: `19.959 USDC`
- post-run balance: `19.958 USDC`
- new on-chain candidate: block `43159850`
- new candidate timestamp: `2026-06-22T00:26:28Z`
- expected relation: approximately 14 seconds after the intent

However, the current binding incorrectly selected the historical settlement:

- old tx: `0xb3329fecc3ec9e5470f21d9c255475c7d8acb2f596aaa7fcf1c18fd579c4e99b`
- old block: `43127024`
- old timestamp: `2026-06-21T06:12:16Z`
- relation to current intent: approximately 18 hours before it

The binding nevertheless reported:

```text
settlement_status: confirmed
matched_by: network,buyer,pay_to,asset,amount,time_window
facilitator_tx_hash: <empty>
facilitator_hash_agrees: true
```

This is a `[VERIFY]` false positive.

### Confirmed defects

1. **Temporal matcher defect**
   - A settlement many hours before `request_started_at_utc` was accepted.
   - `matched_by` falsely included `time_window`.

2. **Facilitator-hash semantics defect**
   - `facilitator_tx_hash` was empty.
   - `facilitator_hash_agrees` was nevertheless `true`.
   - Missing evidence was treated as agreement.

Current honest state:

```text
RESULT: PHASE62_SHARED_EXECUTOR_LIVE_PAYMENT_PROVEN_BINDING_FALSE_POSITIVE
```

Do not emit `PHASE62_SHARED_EXECUTOR_PROVEN` until the acceptance criteria below are met.

---

## 2. Hard safety rules

1. **No new payment.**
2. **No mainnet authorization or mainnet action.**
3. **No new Sepolia authorization.**
4. **No private key loaded into any process or environment variable.**
5. **Never run `trustforge:sepolia:settle`.**
6. **No payment-bearing HTTP request.**
7. **No seller invocation is required for this repair.**
8. **Never reuse the consumed authorization.**
9. **Do not run `git stash pop`.**
10. **No push.**
11. **Do not weaken `PAID-001..008`, single-shot, wallet-match, network guards, or 402 intent validation.**
12. **Never invent a facilitator hash.**
13. **Never classify a missing facilitator hash as agreement.**
14. **Do not alter original on-chain facts to make tests pass.**
15. **Never print or persist private keys, payment authorization headers, signatures, or secret-bearing data.**

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
git log -3 --oneline
git branch --show-current
git switch -c fix/phase62-binding-provenance
```

Do not pop any stash.

Run baseline:

```powershell
npm test
python -m pytest tests -q
```

Expected latest known baseline:

```text
393 passed | 1 skipped
21 passed
```

If baseline is red, diagnose before implementation.

---

## 4. Preserve and inspect the existing evidence

```powershell
$run = "D:\trustforge\artifacts\runs\sepolia-settlement-proof\run_20260621_212429"
```

Hash all artifacts before any read-only reclassification:

```powershell
Get-ChildItem $run -Recurse -File |
  Get-FileHash -Algorithm SHA256 |
  Sort-Object Path |
  Format-Table Hash,Path -AutoSize
```

Locate files:

```powershell
$intentFile = Get-ChildItem $run -Filter "settlement_intent_attempt_*.json" |
  Select-Object -First 1

$bindingFile = Get-ChildItem $run -Filter "settlement_binding_attempt_*.json" |
  Select-Object -First 1
```

Inspect actual schemas instead of assuming field names:

```powershell
$intent = Get-Content $intentFile.FullName -Raw | ConvertFrom-Json
$binding = Get-Content $bindingFile.FullName -Raw | ConvertFrom-Json
$ledgerPath = Join-Path $run "sepolia_reconciliation\onchain_settlement_ledger.json"
$ledger = Get-Content $ledgerPath -Raw | ConvertFrom-Json

$intent.PSObject.Properties | Format-Table Name,Value -AutoSize
$binding.PSObject.Properties | Format-Table Name,Value -AutoSize
$ledger.PSObject.Properties | Format-Table Name,Value -AutoSize
$ledger.settlements[0].PSObject.Properties | Format-Table Name,Value -AutoSize
$ledger.settlements[1].PSObject.Properties | Format-Table Name,Value -AutoSize
```

Search only public transaction references:

```powershell
Get-ChildItem $run -Recurse -File |
  Select-String -Pattern `
    '"(transaction_hash|tx_hash|transactionHash|settlement_tx_hash|facilitator_tx_hash)"\s*:' |
  Select-Object Path,LineNumber,Line |
  Format-List
```

Do not dump arbitrary request headers.

---

## 5. Discover the complete code path

```powershell
git grep -n -E `
  "facilitator_hash_agrees|facilitator_tx_hash|settlement_status|matched_by|time_window|request_started_at_utc|settlement_tx_hash|phase6_settlements_identified|known_settlements_confirmed_onchain" `
  -- tools tests
```

Likely files:

```text
tools/trustforge/settlement-run-binding.ts
tools/trustforge/x402-single-settlement-executor.ts
tools/run-trustforge-sepolia-classify.ts
tools/trustforge/*reconcile*
tests/unit/trustforge-settlement-run-binding.test.ts
tests/unit/trustforge-sepolia-settlement.test.ts
tests/unit/trustforge-x402-single-settlement-executor.test.ts
Python reconciler tests
```

Trace the whole path:

```text
saved execution receipt
→ reconciler ledger
→ settlement candidate normalization
→ temporal filtering
→ binding creation
→ classification
→ RESULT.txt
```

---

## 6. Regression tests — implement all in one pass

### 6.1 Two identical Transfers, old and current

Fixture:

```text
Intent:
  request_started_at_utc = 2026-06-22T00:26:14.368Z
  buyer = 0xf75d...
  pay_to = 0x29865...
  asset = Sepolia USDC
  amount_atomic = 1000

Transfer A — historical:
  tx_hash = 0xb332...e99b
  block = 43127024
  timestamp = 2026-06-21T06:12:16Z
  same buyer/payTo/asset/amount

Transfer B — current:
  tx_hash = NEW_HASH
  block = 43159850
  timestamp = 2026-06-22T00:26:28Z
  same buyer/payTo/asset/amount
```

Assertions:

```text
Transfer A rejected_reason = before_intent_window
Transfer B selected
selected.block_number = 43159850
selected.tx_hash != 0xb332...e99b
matched_by contains time_window only for Transfer B
candidate_count_after_all_filters = 1
```

### 6.2 Historical Transfer only

Required:

```text
settlement_status = settlement_not_found
binding_status != confirmed
facilitator_hash_agrees != true
phase6_settlements_identified = 0
```

### 6.3 Explicit time-boundary tests

Use a named tolerance such as:

```text
CLOCK_SKEW_TOLERANCE_MS = 120000
```

Test:

- 119 seconds before intent;
- 121 seconds before intent;
- exactly at intent time;
- after the upper bound;
- invalid/missing timestamp.

The behavior must be explicit and documented.

### 6.4 Multiple valid current-window candidates

Two candidates match all dimensions and both fall inside the valid window.

Required:

```text
settlement_status = ambiguous_match
binding_status != confirmed
candidate_count = 2
no arbitrary first-item selection
```

### 6.5 Facilitator hash missing

Independent on-chain candidate exists; facilitator hash is null, undefined, or empty.

Required:

```text
settlement_status = facilitator_hash_missing
facilitator_hash_agrees = null or false
binding_status != confirmed
PASS_SETTLED is not emitted
```

### 6.6 Facilitator hash mismatch

Required:

```text
settlement_status = hash_mismatch
facilitator_hash_agrees = false
binding_status != confirmed
```

### 6.7 Facilitator hash agreement

Only a present, non-empty, equal hash may confirm:

```text
settlement_status = confirmed
facilitator_hash_agrees = true
binding_status = confirmed
```

### 6.8 Final result hash source

Test that `settlement_tx_hash` comes only from the confirmed binding for the current `attempt_id`.

Required cases:

- historical/global first settlement cannot leak into current result;
- unconfirmed binding cannot populate the final hash;
- current attempt confirmed binding populates the final hash;
- result attempt ID equals intent attempt ID.

### 6.9 Truthful `matched_by`

`matched_by` may list only checks actually evaluated and passed.

Tests:

- historical transfer does not list `time_window`;
- wrong amount does not list `amount`;
- wrong payTo does not list `pay_to`;
- fully matching transfer lists:
  `network,buyer,pay_to,asset,amount,time_window`.

### 6.10 Already-bound transaction exclusion

If a canonical cross-run binding index already exists, test that a tx bound to a previous attempt cannot bind to the current attempt.

Do not add unnecessary global state only for this test. The temporal filter must independently reject the old tx.

### 6.11 Ledger field normalization

Normalize all supported transaction hash field names to one internal shape:

```ts
interface NormalizedSettlementCandidate {
  txHash: `0x${string}`;
  blockNumber: bigint | number;
  timestampUtc: string;
  network: string;
  buyer: string;
  payTo: string;
  asset: string;
  amountAtomic: string;
}
```

Add tests for the actual current ledger schema and any backward-compatible aliases.

### 6.12 Facilitator response parsing

Test all supported receipt forms used by the installed x402 version:

- `payment-response`;
- `x-payment-response`;
- standard case-insensitive `Headers`;
- base64 or base64url JSON;
- direct JSON, if supported;
- missing receipt;
- malformed receipt.

Required:

```text
valid receipt → tx hash extracted
missing receipt → missing
malformed receipt → missing/malformed, never agreement
```

Never persist request payment headers.

### 6.13 Existing safety invariants

Preserve and run:

```text
PAID-001..008
single-shot
authorization consumption
cross-network key refusal
wallet-match
wrong asset
wrong 402 intent
zero payment-bearing requests on pre-sign refusal
```

No safety test may be removed or weakened.

---

## 7. Correct temporal matching algorithm

A candidate is eligible only if all pass:

1. network;
2. asset;
3. buyer;
4. payTo;
5. amount atomic;
6. explicit intent time window;
7. valid non-empty tx hash;
8. not incompatibly bound elsewhere, if canonical binding history exists.

Recommended logic:

```ts
const requestStartMs = Date.parse(intent.request_started_at_utc);
const lowerBoundMs = requestStartMs - CLOCK_SKEW_TOLERANCE_MS;
const upperBoundMs = Date.parse(
  execution.request_completed_at_utc ??
  execution.executed_at_utc ??
  classificationStartedAtUtc
);

const candidateMs = Date.parse(candidate.timestampUtc);

const inTimeWindow =
  Number.isFinite(candidateMs) &&
  candidateMs >= lowerBoundMs &&
  candidateMs <= upperBoundMs;
```

Requirements:

- invalid timestamps are rejected or hard-fail;
- missing timestamp never matches;
- do not use reconciliation scan start as the intent lower bound;
- a 50,000-block scan range is not a run-attribution window;
- `matched_by: time_window` appears only when `inTimeWindow === true`.

Cardinality after filters:

```text
0 → settlement_not_found
1 → continue to facilitator hash cross-check
>1 → ambiguous_match
```

Never silently `.find()` or select `[0]`.

---

## 8. Correct facilitator-hash semantics

Make the invalid state impossible.

Recommended types:

```ts
type SettlementBindingStatus =
  | "confirmed"
  | "settlement_not_found"
  | "ambiguous_match"
  | "facilitator_hash_missing"
  | "hash_mismatch";

type FacilitatorHashCrossCheck =
  | "agree"
  | "missing"
  | "mismatch";
```

Required logic:

```ts
if (!independentCandidate) {
  status = "settlement_not_found";
} else if (!facilitatorHash) {
  status = "facilitator_hash_missing";
  hashCrossCheck = "missing";
} else if (
  normalizeHash(facilitatorHash) !==
  normalizeHash(independentCandidate.txHash)
) {
  status = "hash_mismatch";
  hashCrossCheck = "mismatch";
} else {
  status = "confirmed";
  hashCrossCheck = "agree";
}
```

If retaining the legacy boolean:

```ts
facilitator_hash_agrees =
  status === "confirmed" ? true :
  status === "hash_mismatch" ? false :
  null;
```

It must never be `true` when the facilitator hash is absent.

---

## 9. Recover the current run’s transaction hash read-only

The expected current Transfer:

```text
network: eip155:84532
asset: 0x036CbD53842c5426634e7929541eC2318f3dCF7e
from: 0xf75d6B83D366a6E9Fc2fb8bf113D67050c44F392
to: 0x29865d0e41a75470c5d8aa9f0e0b373518f7fe71
amount: 1000 atomic
block: 43159850
timestamp: 2026-06-22T00:26:28Z
```

Obtain the public hash from:

1. the canonical ledger’s actual field;
2. a read-only RPC `Transfer` log query;
3. an existing sanitized facilitator receipt.

The current hash must:

- be valid `0x` + 64 hex;
- differ from `0xb3329fecc3ec9e5470f21d9c255475c7d8acb2f596aaa7fcf1c18fd579c4e99b`.

---

## 10. Recover or honestly mark the facilitator hash

Search sanitized response artifacts only:

```powershell
Get-ChildItem $run -Recurse -File |
  Select-String -Pattern `
    'payment-response|x-payment-response|facilitator.*hash|transaction.*hash' |
  Select-Object Path,LineNumber,Line |
  Format-List
```

Do not print request payment headers.

### A. Receipt exists

Fix extraction and require exact equality with the independently found current tx.

### B. Receipt was not persisted

Do not fabricate it.

Correct result:

```text
independent settlement match: found
facilitator hash cross-check: missing
settlement_status: facilitator_hash_missing
```

The code repair may pass, but the strict Phase 6.2 milestone remains incomplete until a future human-authorized regression persists the receipt.

### C. Receipt hash differs

Correct result:

```text
settlement_status: hash_mismatch
```

No PASS.

---

## 11. Binding schema

Confirmed:

```json
{
  "attempt_id": "attempt_8e1a854c-c841-47b9-937c-5549857484a5",
  "run_id": "run_20260621_212429",
  "authorization_hash": "a6ab2d6b518734e807515e99fb816c1c6669759a1f030693b6ec87cc4d6a1a03",
  "independent_match": {
    "settlement_tx_hash": "0xCURRENT...",
    "block_number": 43159850,
    "timestamp_utc": "2026-06-22T00:26:28Z",
    "actual_spend_atomic": "1000"
  },
  "facilitator_reported_hash": "0xCURRENT...",
  "facilitator_hash_cross_check": "agree",
  "settlement_status": "confirmed",
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

Missing facilitator receipt:

```json
{
  "facilitator_reported_hash": null,
  "facilitator_hash_cross_check": "missing",
  "facilitator_hash_agrees": null,
  "settlement_status": "facilitator_hash_missing"
}
```

---

## 12. Metrics semantics

Separate global history from current-run attribution.

Global ledger can correctly report:

```text
total_outflow_settlements_found: 2
total_outflow_usdc: 0.002
```

Current run must report:

```text
current_attempt_id: attempt_8e1a854c-c841-47b9-937c-5549857484a5
current_attempt_candidates_after_filter: 1
known_settlements_confirmed_onchain: 1
phase6_settlements_identified: 1
unattributed_settlements_found: 0
current_attempt_settlement_block: 43159850
current_attempt_settlement_tx_hash: 0xCURRENT...
```

These counters must come from a valid binding for the current attempt, not merely from “some wallet outflow exists.”

Under the current definition, `PASS_SETTLED` requires:

- one independent current-window match;
- current run/attempt/authorization linkage;
- non-empty facilitator hash;
- hash agreement;
- balance identity pass;
- no secret leakage;
- no mainnet use.

If the facilitator hash is missing, use an honest non-pass status such as:

```text
SETTLED_ONCHAIN_FACILITATOR_HASH_MISSING
```

---

## 13. Reclassify the existing run only

After fixes and tests, preserve old generated outputs before regeneration if necessary.

Ensure keys are absent:

```powershell
Remove-Item Env:\SEPOLIA_BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue
Remove-Item Env:\BUYER_PRIVATE_KEY -ErrorAction SilentlyContinue
```

Run only:

```powershell
node .\seller-api\node_modules\tsx\dist\cli.mjs `
  .\tools\run-trustforge-sepolia-classify.ts `
  --run-dir `
  "D:\trustforge\artifacts\runs\sepolia-settlement-proof\run_20260621_212429"
```

Never run settlement.

### Expected if receipt is recoverable

```text
total_outflow_settlements_found: 2
current_attempt_candidates_after_filter: 1
known_settlements_confirmed_onchain: 1
phase6_settlements_identified: 1
unattributed_settlements_found: 0
binding_status: confirmed
facilitator_hash_agrees: true
current_attempt_settlement_block: 43159850
settlement_tx_hash: 0xCURRENT_HASH_NOT_OLD_HASH
balance_identity_status: pass
paid_probe_outcome: PASS_SETTLED
```

### Expected if receipt is unavailable

```text
independent_current_attempt_match: found
current_attempt_settlement_block: 43159850
settlement_tx_hash: 0xCURRENT...
facilitator_hash_cross_check: missing
binding_status: facilitator_hash_missing
paid_probe_outcome: not_pass_settled
```

No false `confirmed`.

---

## 14. Full validation matrix

```powershell
npx vitest run `
  tests/unit/trustforge-settlement-run-binding.test.ts `
  tests/unit/trustforge-sepolia-settlement.test.ts `
  tests/unit/trustforge-x402-single-settlement-executor.test.ts `
  tests/unit/trustforge-phase6-1-hardening.test.ts `
  tests/unit/trustforge-phase6-authorization.test.ts `
  --reporter=verbose

npm test
python -m pytest tests -q
git diff --check
git status --short
```

Minimum full-suite baseline:

```text
393 passed | 1 skipped
21 reconciler tests passed
```

New tests should increase the count.

Check for secret leakage carefully:

```powershell
git grep -n -E `
  "PRIVATE_KEY=|payment-signature|authorizationSignature" `
  -- tools tests
```

Public field names are acceptable; secret values are not.

---

## 15. Commit policy

Focused local commits, no push.

Suggested sequence:

```powershell
git add tests
git commit -m "Add Phase 6.2 binding false-positive regressions"

git add tools
git commit -m "Fix temporal settlement binding and facilitator hash semantics"
```

Do not commit:

- `__pycache__`;
- private keys;
- secret headers;
- unrelated stash content;
- mangled `phase6-paid-invariants.ts`;
- mainnet authorization;
- a new payment authorization.

---

## 16. Final agent result

### Strict success

```text
RESULT: PHASE62_SHARED_EXECUTOR_PROVEN

Existing live payment only:
  no new payment performed

Current attempt:
  attempt_8e1a854c-c841-47b9-937c-5549857484a5

Independent match:
  block 43159850
  timestamp 2026-06-22T00:26:28Z
  tx hash 0xCURRENT...
  amount 0.001 USDC

Historical settlement:
  0xb332...e99b rejected as before_intent_window

Binding:
  current attempt 1/1
  facilitator hash present and equal
  no ambiguity
  no unattributed settlement

Safety:
  no key loaded
  no payment
  no mainnet
  no push

Tests:
  <new count> passed | 1 skipped
  21 reconciler tests passed
```

### Partial success — receipt unavailable

```text
RESULT: PHASE62_BINDING_TEMPORAL_FIX_PASS_FACILITATOR_RECEIPT_MISSING

Independent current-run match:
  block 43159850 selected correctly

Historical false positive:
  fixed

Facilitator hash:
  unavailable in preserved artifacts

Binding:
  facilitator_hash_missing
  not confirmed under strict Phase 6.2 definition

Payment:
  no new payment performed

Next human gate:
  future Sepolia regression only after explicit new authorization
```

### Failure

```text
RESULT: PHASE62_BINDING_REPAIR_NOT_PROVEN

Reason:
  hash_mismatch | ambiguous_match | settlement_not_found | test failure

Safety:
  no payment
  no key loaded
  mainnet blocked
```

---

## 17. Definition of done

```text
[ ] Old tx at block 43127024 rejected for current intent
[ ] New tx at block 43159850 selected independently
[ ] Time window explicit and tested
[ ] matched_by truthful
[ ] Missing facilitator hash is not agreement
[ ] Hash mismatch is not confirmed
[ ] Ambiguity is not silently resolved
[ ] RESULT hash comes from current attempt binding only
[ ] Global outflow count 2 separated from current-run attribution 1
[ ] PAID-001..008 remain green
[ ] Full TypeScript suite green
[ ] Python reconciler suite green
[ ] No private key loaded
[ ] No payment executed
[ ] No mainnet action
[ ] No stash pop
[ ] No push
```

Overall Phase 6.2 is complete only if the preserved run also has a recoverable facilitator hash equal to the independently selected current transaction hash.

---

## 18. Autonomous execution style

Execute the whole loop without pausing for routine confirmation:

```text
inspect
→ reproduce with tests
→ patch
→ run focused tests
→ run full tests
→ inspect preserved artifacts
→ reclassify read-only
→ correct remaining defects
→ repeat until green or a genuine evidence limitation is reached
→ commit locally
→ print the honest final result
```

Stop only for:

- loading any private key;
- any payment;
- any mainnet action;
- destructive evidence mutation;
- a genuine need for a new human authorization.
