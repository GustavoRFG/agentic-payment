# TrustForge Git remotes

This note records the real remote topology for the two repositories used by
TrustForge and the safe path forward. It does **not** rewrite history or change
any remote automatically.

## Current state

| Local path | Role | Remote (`origin`) |
|---|---|---|
| `D:\trustforge` | workspace / artifacts repo | `https://github.com/GustavoRFG/trustforge.git` |
| `D:\agentic-payments-lab` | source code repo | `https://github.com/GustavoRFG/agentic-payment.git` |

`D:\agentic-payments-lab` also has a second remote `private-backup` pointing at
`https://github.com/GustavoRFG/agentic-payments-lab.git`. A prior push attempt to
that remote failed with *repository not found* (the repo does not exist yet).

## History notes

- `git push --all` and `git push --tags` were previously run against `origin`
  (`agentic-payment.git`) for the source repo.
- Do **not** run `git push --all` or `git push --tags` again without an explicit
  audit of which branches/tags are intended to be public.

## Recommended future (intentional, not automatic)

- Source code: keep at `agentic-payment.git`, **or** deliberately create a new
  private repo and migrate with intent (not via `--all`/`--tags`).
- If `private-backup` is desired, first create the private repo
  `GustavoRFG/agentic-payments-lab` on GitHub, then push a single named branch
  under the dedicated backup authorization gate
  (`TRUSTFORGE_AUTHORIZE_PRIVATE_GITHUB_BACKUP`).

## Rules

- No history rewrite (`reset --hard`, `clean`, `restore`, `checkout --`,
  force-push).
- No automatic new branches/tags.
- No `--all` / `--tags` pushes.
- Remote backup pushes require `TRUSTFORGE_AUTHORIZE_PRIVATE_GITHUB_BACKUP=YES_CREATE_OR_PUSH_PRIVATE_BACKUP`
  and even then only a single named branch.
