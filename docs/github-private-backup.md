# GitHub Private Backup Preparation

## Recommended Repository

- name: `agentic-payments-lab`
- visibility: private
- description: `Experimental x402 agent-commerce lab evolving into TrustForge: auditable, default-deny infrastructure for probing and verifying paid agent services.`

Suggested topics:

- `x402`
- `agentic-payments`
- `ai-agents`
- `mcp`
- `usdc`
- `base`
- `trust-layer`
- `evals`
- `benchmarking`
- `typescript`
- `nodejs`

Do not initialize the GitHub repository with a README, `.gitignore`, or
LICENSE. The local repository already contains history and project files.

## Local Snapshot

- branch: `mvp-007a-local-paid-mcp-gateway`
- head before backup-prep commit: `f9995a2beef34844e877050247e8dc994d498a7e`
- remote observed before this prep: `origin https://github.com/GustavoRFG/agentic-payment.git`
- remote status: `REMOTE_REVIEW_REQUIRED`
- `SKILL.md`: present
- `docs/trustforge-status.md`: present
- workspace consolidation: present in history

## Secret Hygiene Summary

No `.env` contents were opened or printed.

Tracked file scan:

| Item | Classification |
|---|---|
| `buyer-client/.env.example` | safe_documentation_placeholder |
| `seller-api/.env.example` | safe_documentation_placeholder |
| `mcp-gateway/.env.example` | safe_documentation_placeholder |
| `buyer-client/src/check-wallet-balances.ts` | safe_source_reference |
| `docs/wallet-bridge-status.md` | safe_documentation_placeholder |

Results:

- tracked real `.env` files: 0
- potential secret files: 0
- `.env` ignored by `.gitignore`: yes
- `gitleaks`: not available in this environment
- conservative history marker scan: PASS, variable-name and documentation/test/code references only
- high-risk pattern scan: PASS, only public transaction-style hashes in docs and one redacted test dummy were found

The `.gitignore` protects:

- `.env`
- `.env.*`
- `node_modules/`
- `dist/`
- `coverage/`
- `runtime/`
- `artifacts/`
- logs and local runtime directories

## Validation

Run during backup preparation:

```powershell
npm.cmd test
npm.cmd run seller:build
npm.cmd run buyer:build
npm.cmd run mcp:build
git -C D:\agentic-payments-lab diff --check
```

Results:

- tests: PASS, 163 passed and 1 controlled-payment test skipped by design
- seller build: PASS
- buyer build: PASS
- MCP build: PASS
- diff check: PASS
- live wallet load: not performed
- live payment: not performed
- push: not performed

## Manual GitHub Steps

Create an empty private GitHub repository named:

```text
agentic-payments-lab
```

Enable GitHub security options when available:

```text
Settings -> Security -> enable secret scanning / push protection
```

The existing local `origin` points to `GustavoRFG/agentic-payment.git`, so do
not push until the remote target is manually reviewed.

After confirming the intended private repository, use one of the following
manual paths.

If the existing `origin` should be replaced:

```powershell
cd D:\agentic-payments-lab
git remote set-url origin https://github.com/GustavoRFG/agentic-payments-lab.git
git push -u origin mvp-007a-local-paid-mcp-gateway
```

If keeping the existing `origin`, add a separate private backup remote:

```powershell
cd D:\agentic-payments-lab
git remote add private-backup https://github.com/GustavoRFG/agentic-payments-lab.git
git push -u private-backup mvp-007a-local-paid-mcp-gateway
```

Do not make the repository public before MVP-T0C and a second public-release
sanitization review.
