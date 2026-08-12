/**
 * b352-execution-gates — Windows masked secret dialog failures.
 * Never include credential material in error messages.
 */

export const BLOCKED_B352_SECRET_DIALOG_CANCELLED =
  "BLOCKED_B352_SECRET_DIALOG_CANCELLED" as const;
export const BLOCKED_B352_SECRET_DIALOG_CLOSED =
  "BLOCKED_B352_SECRET_DIALOG_CLOSED" as const;
export const BLOCKED_B352_SECRET_DIALOG_INVALID =
  "BLOCKED_B352_SECRET_DIALOG_INVALID" as const;
export const BLOCKED_B352_SECRET_DIALOG_UNAUTHORIZED =
  "BLOCKED_B352_SECRET_DIALOG_UNAUTHORIZED" as const;
export const BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT =
  "BLOCKED_B352_SECRET_DIALOG_SECOND_ATTEMPT" as const;
export const BLOCKED_B352_SECRET_DIALOG_PLATFORM =
  "BLOCKED_B352_SECRET_DIALOG_PLATFORM" as const;

export function assertB352SecretDialogCancelled(detail = "user cancelled"): never {
  throw new Error(`${BLOCKED_B352_SECRET_DIALOG_CANCELLED}: ${detail}`);
}

export function assertB352SecretDialogClosed(detail = "window closed"): never {
  throw new Error(`${BLOCKED_B352_SECRET_DIALOG_CLOSED}: ${detail}`);
}
