/**
 * b35-execution-gates — hidden TTY secret-entry failures.
 * Never include credential material in error messages.
 */

export const BLOCKED_B35_INTERACTIVE_TTY_REQUIRED =
  "BLOCKED_B35_INTERACTIVE_TTY_REQUIRED" as const;
export const BLOCKED_B35_SECRET_ENTRY_ABORTED =
  "BLOCKED_B35_SECRET_ENTRY_ABORTED" as const;
export const BLOCKED_B35_SECRET_ENTRY_OVERSIZED =
  "BLOCKED_B35_SECRET_ENTRY_OVERSIZED" as const;
export const BLOCKED_B35_SECRET_ENTRY_INVALID =
  "BLOCKED_B35_SECRET_ENTRY_INVALID" as const;
export const BLOCKED_B35_SECRET_ENTRY_TIMEOUT =
  "BLOCKED_B35_SECRET_ENTRY_TIMEOUT" as const;
export const BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED =
  "BLOCKED_B35_SECRET_ENTRY_UNAUTHORIZED" as const;
export const BLOCKED_B35_SECRET_ENTRY_CONSUMED =
  "BLOCKED_B35_SECRET_ENTRY_CONSUMED" as const;
export const BLOCKED_B35_SECRET_ENTRY_AMBIGUOUS =
  "BLOCKED_B35_SECRET_ENTRY_AMBIGUOUS" as const;
export const BLOCKED_B35_SECRET_ENTRY_FALLBACK_FORBIDDEN =
  "BLOCKED_B35_SECRET_ENTRY_FALLBACK_FORBIDDEN" as const;
export const BLOCKED_B35_SECRET_ENTRY_BEFORE_GATE =
  "BLOCKED_B35_SECRET_ENTRY_BEFORE_GATE" as const;

export function assertB35InteractiveTtyRequired(): never {
  throw new Error(
    `${BLOCKED_B35_INTERACTIVE_TTY_REQUIRED}: hidden credential entry requires an interactive TTY; no piped-stdin/env/argv/file/clipboard fallback`,
  );
}

export function assertB35SecretEntryAborted(detail: string): never {
  throw new Error(`${BLOCKED_B35_SECRET_ENTRY_ABORTED}: ${detail}`);
}

export function assertB35NoSecretEntryFallback(): never {
  throw new Error(
    `${BLOCKED_B35_SECRET_ENTRY_FALLBACK_FORBIDDEN}: secret entry must not fall back to argv, env, file, clipboard, visible stdin, or shell`,
  );
}
