# Screenshots

This folder holds sanitized screenshots used in the public demo and README.

- `dashboard-local-audit.png` — the local x402 audit dashboard rendered from
  the current JSONL audit summaries.

The dashboard only renders sanitized KPI fields. It never shows private keys,
CDP secrets, `.env` contents, raw x402 payment headers, or raw signatures.
Confirm this before committing any new screenshot.

## Refresh the dashboard screenshot

### Manual (works everywhere)

```powershell
cd D:\agentic-payments-lab
npm.cmd run demo:local
npm.cmd run dashboard:open
```

Then capture the browser window and save it as:

```text
docs/screenshots/dashboard-local-audit.png
```

### Automated (headless Edge, Windows)

```powershell
cd D:\agentic-payments-lab
npm.cmd run dashboard:render

$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
& $edge --headless=new --disable-gpu --hide-scrollbars --window-size=1440,1200 `
  --screenshot="D:\agentic-payments-lab\docs\screenshots\dashboard-local-audit.png" `
  "file:///D:/agentic-payments-lab/dashboard/index.html"
```

If `msedge.exe` lives under `Program Files` instead of `Program Files (x86)`,
adjust the path accordingly.

## Safety

Do not commit a screenshot that shows any secret value. If a future dashboard
revision surfaces sensitive fields, fix the renderer first, then recapture.
