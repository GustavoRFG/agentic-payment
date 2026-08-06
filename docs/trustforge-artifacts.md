# TrustForge Artifacts

Source repo: `D:\agentic-payments-lab`

Workspace: `D:\trustforge`

Artifacts root: `D:\trustforge\artifacts\runs`

Do not create TrustForge scratch directories directly under `D:\`. New run
output belongs under:

```text
D:\trustforge\artifacts\runs\<stage>\run_<YYYYMMDD_HHMMSS>
```

Historical runs consolidated in this workspace include:

- `spike-zero`
- `mvp-t0-paid`
- `mvp-t0a-adapter`
- `mvp-t0b-readiness`
- `mvp-t0b1-binding`
- `consolidation-binding-audit`
- `fast-track-e2e`

The artifact index is maintained at:

```text
D:\trustforge\artifacts\index.json
```

## In-repo TrustForge bootstrap assets

These tracked, sanitized assets live inside the source repo (not under the
artifacts root) because they are code/contract inputs, not run evidence:

```text
contracts/trustforge/*.schema.json          # JSON Schema contracts
trustforge/registry/services.bootstrap.json # 8-service bootstrap registry
trustforge/tasks/onesource_api_chain_id/    # ServiceEvalTask definitions
trustforge/fixtures/                         # MOCK probe/eval/score fixtures only
trustforge/evidence/t0c_first_paid_probe/    # REAL T0C probe/eval/score + on-chain proof
tools/trustforge/json-schema-lite.ts         # dependency-free validator
tools/trustforge/contracts.ts                # contract loader/validator
tools/trustforge/evaluate-bootstrap-probe.ts # deterministic evaluator
tools/trustforge/consolidate-bootstrap-trust-score.ts
```

Real per-run outputs are written locally to `trustforge/runtime/` (git-ignored).
The committed, sanitized copies of the first real settlement live under
`trustforge/evidence/t0c_first_paid_probe/` (`probe_run.json`,
`evaluation_result.json`, `trust_score.json`, `onchain_verification.md`).

The `fast-track-e2e` run (`D:\trustforge\artifacts\runs\fast-track-e2e\run_<ts>`)
holds the run log, snapshots, governance/secret/binding reports, the T0C paid
execution and on-chain verification, contracts validation, tests, builds, and the
final report. Run `run_20260614_010720` is the first real paid T0C smoke (PASS).

## Thin settlement request binding

Fresh discovery output uses `trustforge_target_selection.v4` and
`trustforge_target_resolution_evidence.v4`. Primary/fallback candidates and the
corresponding evidence persist the canonical request endpoint, method, query,
body, input provenance, and `request_binding_sha256`. A
`selected_candidate.json` must carry the identical fields and hash. Artifacts
from older schemas that do not persist the request binding fail closed with
`REJECTED_REQUEST_BINDING_NOT_PERSISTED`; absence is never interpreted as an
empty request input.

The same discovery artifacts now persist the full protocol-versioned seller
`PaymentRequirements`, `requirements_observed_at`, normalized requirements
binding, and canonical requirements/envelope SHA-256 hashes. The selected
candidate schema is `trustforge_selected_candidate.v3`; the human authorization
schema is `trustforge_paid_probe_authorization.v3`; and the prepared settlement
intent schema is `trustforge_settlement_intent.v3`. These artifacts persist
`seller_network_raw` separately from `canonical_network_caip2`; the former stays
inside the seller hashes and the latter is the exact execution/chain profile.
Older artifacts without the
seller binding fail closed with
`REJECTED_PAYMENT_REQUIREMENTS_BINDING_NOT_PERSISTED`; hashes are never rebuilt
from quote, asset, or `payTo` summaries.

Tempo `WWW-Authenticate` `method`/`id`/`expires` values are retained only as
typed ancillary evidence (`authoritative: false`,
`used_as_eip3009_nonce: false`). They are not x402 core timeout or buyer
EIP-3009 nonce/validity fields.

Until B.2, prepared intent fields do not make a run executable. Productive paid
entry points stop unconditionally with
`BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED` before any key,
nonce, signer, payment header, fetch, or intent-consumption side effect.

Rich Phase 5 `selected_candidate.json` and
`human_payment_authorization_template.json` artifacts also carry the canonical
method, query, body, `request_binding_sha256`, and auditable request summary.
Phase 6 reads the authorized hash from the human artifact; the paid rich planner
must independently reproduce it before any wallet environment is loaded.
