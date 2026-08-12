/**
 * buyer-secret-entry-mechanism — allowed one-shot human secret-entry UIs.
 *
 * Mechanism selection does not change economic, signing, or send authority.
 */

import { B4_PROTECTED_VAULT_SECRET_ENTRY } from "./b4-execution-gates";

export const B35_SECRET_ENTRY_MECHANISM = "HIDDEN_PARENT_TTY_ONE_SHOT" as const;
export const B352_SECRET_ENTRY_MECHANISM =
  "WINDOWS_MASKED_SECRET_DIALOG_ONE_SHOT" as const;
/** B.4 protected vault — no private-key prompt (alias of B4_PROTECTED_VAULT_SECRET_ENTRY). */
export const WINDOWS_DPAPI_VAULT_ONE_SHOT = B4_PROTECTED_VAULT_SECRET_ENTRY;
export { B4_PROTECTED_VAULT_SECRET_ENTRY };

export type SecretEntryMechanism =
  | typeof B35_SECRET_ENTRY_MECHANISM
  | typeof B352_SECRET_ENTRY_MECHANISM
  | typeof WINDOWS_DPAPI_VAULT_ONE_SHOT;

export function isAllowedSecretEntryMechanism(
  value: unknown,
): value is SecretEntryMechanism {
  return (
    value === B35_SECRET_ENTRY_MECHANISM ||
    value === B352_SECRET_ENTRY_MECHANISM ||
    value === WINDOWS_DPAPI_VAULT_ONE_SHOT
  );
}

/** Windows operational default after B.3.5.2 (runtime-key path). */
export const WINDOWS_OPERATIONAL_SECRET_ENTRY_MECHANISM = B352_SECRET_ENTRY_MECHANISM;
