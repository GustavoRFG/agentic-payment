/**
 * buyer-credential-transport-parent — synthetic-only parent launcher.
 *
 * Solves parent → child transport only.
 * Does NOT implement human → parent secret entry.
 *
 * Production invocation without an authorized synthetic credential source
 * blocks before creating a secret frame.
 */

import {
  BLOCKED_B34_CREDENTIAL_TRANSPORT_SOURCE_UNAUTHORIZED,
} from "./b34-execution-gates";
import {
  spawnCredentialTransportChild,
  type SpawnCredentialTransportChildResult,
} from "./buyer-credential-transport-pipe";
import { B34_TRANSPORT_PAYLOAD_EXACT_LENGTH } from "./buyer-credential-transport-frame";

/**
 * Branded synthetic credential source — only tests/support may construct this.
 * Productive code must never forge it for operational keys.
 */
export interface SyntheticCredentialTransportSource {
  readonly __brand: "SyntheticCredentialTransportSource";
  readonly bytes: Uint8Array;
}

export function assertSyntheticCredentialTransportSource(
  source: SyntheticCredentialTransportSource | null | undefined,
): asserts source is SyntheticCredentialTransportSource {
  if (!source || source.__brand !== "SyntheticCredentialTransportSource") {
    throw new Error(
      `${BLOCKED_B34_CREDENTIAL_TRANSPORT_SOURCE_UNAUTHORIZED}: only a branded synthetic credential source may create a transport frame; human secret-entry is not implemented`,
    );
  }
  if (
    !(source.bytes instanceof Uint8Array) ||
    source.bytes.byteLength !== B34_TRANSPORT_PAYLOAD_EXACT_LENGTH
  ) {
    throw new Error(
      `${BLOCKED_B34_CREDENTIAL_TRANSPORT_SOURCE_UNAUTHORIZED}: synthetic source payload must be exactly 32 bytes`,
    );
  }
}

/**
 * Launch a child with one synthetic framed credential on fd 3.
 * Blocks if source is not a branded synthetic fixture.
 */
export async function launchSyntheticCredentialTransportChild(input: {
  readonly source: SyntheticCredentialTransportSource | null | undefined;
  readonly scriptPath: string;
  readonly scriptArgs?: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<SpawnCredentialTransportChildResult> {
  assertSyntheticCredentialTransportSource(input.source);
  return spawnCredentialTransportChild({
    scriptPath: input.scriptPath,
    scriptArgs: input.scriptArgs,
    syntheticCredentialBytes: input.source.bytes,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    env: input.env,
  });
}

/** Production parent path without authorized source — always blocks. */
export function assertProductionCredentialTransportParentInactive(): never {
  throw new Error(
    `${BLOCKED_B34_CREDENTIAL_TRANSPORT_SOURCE_UNAUTHORIZED}: productive parent launcher has no human secret-entry mechanism; transport remains inactive`,
  );
}
