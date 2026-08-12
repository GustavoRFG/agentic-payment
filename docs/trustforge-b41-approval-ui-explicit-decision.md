# TrustForge B.4.1 — Explicit payment approval decisions

## Problem

The B.4 repeatability canary
`D:\trustforge\artifacts\runs\b4-repeatability-canary\run_20260812_043500`
was recorded as `HUMAN_REJECTED_NO_PAYMENT`. The human operator states they did
**not** click Reject; the Approve/Reject window appeared briefly and closed
before a decision.

Write-once historical artifacts for that run are preserved. A corrective
addendum lives beside them:

`CORRECTIVE_INTERPRETATION_B41.json`

with:

- `HUMAN_REJECTED_EXPLICITLY = false`
- `VALID_HUMAN_DECISION_CAPTURED = false`
- `disposition = APPROVAL_UI_CLOSED_WITHOUT_EXPLICIT_HUMAN_DECISION`

## Root cause

1. **Classification bug:** `windows-approve-reject-dialog.ts` mapped process exit
   code `3` (window close / `CLOSED`) to `decision: "REJECT"` with
   `reason: "closed"`.
2. **UI contributing factor:** Reject was `ActiveControl` with
   `DialogResult=Abort`, so Enter/focus races could dismiss the dialog without an
   explicit Reject click.

## Required production semantics (B.4.1)

| Human action | Decision | `decision_source` | `explicit_human_decision` |
|---|---|---|---|
| Approve button | `APPROVE` | `approve_button` | `true` |
| Reject button | `REJECT` | `reject_button` | `true` |
| Window X | `ABORT` | `window_close` | `false` |
| Esc / keyboard close | `ABORT` | `keyboard_close` | `false` |
| UI/process error | `UI_FAILED` | `ui_failure` | `false` |

No other event may produce `HUMAN_REJECTED` / `REJECT`.

Operational Windows provider invariants:

- no automatic timeout, auto-close, auto-submit, or synthetic decision;
- `ShowDialog` blocks until explicit human interaction;
- dialog brought to foreground with amount / network / seller / request;
- closing the window is fail-closed as `ABORT`, not `REJECT`;
- approval occurs **before** the fresh unpaid 402; seller 300s freshness is
  **not** an approval-dialog timeout; JIT timer starts only after explicit
  APPROVE + fresh 402.

## Evidence

`D:\trustforge\artifacts\runs\b41-approval-ui-explicit-decision\`

## Result

`B41_APPROVAL_UI_EXPLICIT_DECISION_READY_NO_PAYMENT`
