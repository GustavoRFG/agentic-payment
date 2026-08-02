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

Fresh discovery output uses `trustforge_target_selection.v2` and
`trustforge_target_resolution_evidence.v2`. Primary/fallback candidates and the
corresponding evidence persist the canonical request endpoint, method, query,
body, input provenance, and `request_binding_sha256`. A
`selected_candidate.json` must carry the identical fields and hash. Artifacts
from older schemas that do not persist the request binding fail closed with
`REJECTED_REQUEST_BINDING_NOT_PERSISTED`; absence is never interpreted as an
empty request input.
