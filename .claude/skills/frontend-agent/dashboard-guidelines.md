# Dashboard Guidelines

The first dashboard should be local and low-risk.

Use the JSON shape emitted by:

```powershell
npm.cmd run logs:summary -- --json
```

Do not read `.env`.

Do not read `secrets/`.

Do not read full raw payment headers.

Do not read or render full generated JSONL lines if they contain unexpected fields. Prefer summarized fields.

Recommended first implementation:

```text
tools/render-dashboard.ts
```

It should:

1. Run or import the same summary logic as `tools/log-summary.ts`.
2. Produce a local static HTML file.
3. Write to `dashboard/index.html` or `reports/dashboard.html`.
4. Avoid external network resources.
5. Include KPI cards and recent event tables.
