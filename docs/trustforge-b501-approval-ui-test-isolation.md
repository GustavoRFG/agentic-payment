# TrustForge B.5.0.1 — Human Approval UI Test Isolation

**RESULT:** `B501_HUMAN_APPROVAL_UI_TEST_ISOLATION_READY_NO_PAYMENT`

## Intent

Visible Approve/Reject UI must mean a real human checkpoint. Automated unit and
regression suites must never spawn the production dialog, UI Automation harness,
or mouse/keyboard injection against that dialog.

## Separation

| Path | Factory / ID | Role |
|------|----------------|------|
| Production | `createWindowsApproveRejectDialogProvider` | Requires `OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT`; blocked when `VITEST=true` or `NODE_ENV=test` |
| Tests | `createTestHumanPaymentDecisionProvider` (`test-human-payment-decision`) | Headless APPROVE / REJECT / ABORT; no GUI |
| Legacy harness | `windows-approve-reject-dialog-test-harness.ps1` | Manual operator probe only; forbidden in automated tests |

`TEST DECISION != HUMAN DECISION`.

## CLI

`tools/run-trustforge-mainnet-payment.ts` still passes
`OPERATIONAL_HUMAN_APPROVAL_UI_CHECKPOINT` so an operator-run CLI can reach the
production dialog. That checkpoint is UI reachability only — not payment
authorization. This engineering task does not launch the dialog.

## Preserved evidence

B.4.3 human UX acceptance remains write-once at:

`D:\trustforge\artifacts\runs\b43-human-approval-ui-acceptance`

## Safety

- No real payment
- No DPAPI signer for payment in this task
- No production Approve/Reject dialog launch
- No OttoAI canary