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
tools/trustforge/json-schema-lite.ts         # dependency-free validator
tools/trustforge/contracts.ts                # contract loader/validator
tools/trustforge/evaluate-bootstrap-probe.ts # deterministic evaluator
tools/trustforge/consolidate-bootstrap-trust-score.ts
```

The `fast-track-e2e` run (`D:\trustforge\artifacts\runs\fast-track-e2e\run_<ts>`)
holds the run log, snapshots, governance/secret/binding reports, T0C preflight
(human-gated, not executed), contracts validation, tests, builds, and the final
report.
