# TrustForge B.4.1.1 — Windows PowerShell 5.1 approval UI encoding

## Root cause (confirmed)

Operational probe
`D:\trustforge\artifacts\runs\b4-repeatability-canary\run_20260812_174124`
failed with `BLOCKED_B4_HUMAN_DECISION_UI_FAILED` because
`windows-approve-reject-dialog.ps1` contained UTF-8 non-ASCII typography
(em-dashes) without a BOM. Windows PowerShell 5.1 (`powershell.exe`) decoded
the file via the legacy system code page, parse failed before `ShowDialog`,
and the provider recorded `UI_FAILED`.

Historical runs `run_20260812_043500` and `run_20260812_174124` remain
write-once.

## Corrective

- Production launcher is ASCII-only (preferred over BOM-dependent UTF-8).
- Structural encoding guard:
  `WINDOWS_PS51_APPROVAL_SCRIPT_ENCODING_SAFE = PASS`
- Production provider asserts encoding safety before spawn.
- B.4.1 explicit-decision semantics unchanged (Approve/Reject buttons only;
  window close = ABORT; no timeout/auto-close/auto-submit).
- Test harness
  `windows-approve-reject-dialog-test-harness.ps1` drives the production
  dialog via UI Automation; production has no harness flags.

## Evidence

`D:\trustforge\artifacts\runs\b411-ps51-approval-ui-encoding\`

## Result

`B411_PS51_APPROVAL_UI_READY_NO_PAYMENT`
