/**
 * buyer-secret-entry-mechanism — allowed one-shot human secret-entry UIs.
 *
 * Mechanism selection does not change economic, signing, or send authority.
 */

export const B35_SECRET_ENTRY_MECHANISM = "HIDDEN_PARENT_TTY_ONE_SHOT" as const;
export const B352_SECRET_ENTRY_MECHANISM =
  "WINDOWS_MASKED_SECRET_DIALOG_ONE_SHOT" as const;

export type SecretEntryMechanism =
  | typeof B35_SECRET_ENTRY_MECHANISM
  | typeof B352_SECRET_ENTRY_MECHANISM;

export function isAllowedSecretEntryMechanism(
  value: unknown,
): value is SecretEntryMechanism {
  return value === B35_SECRET_ENTRY_MECHANISM || value === B352_SECRET_ENTRY_MECHANISM;
}

/** Windows operational default after B.3.5.2. */
export const WINDOWS_OPERATIONAL_SECRET_ENTRY_MECHANISM = B352_SECRET_ENTRY_MECHANISM;
