/**
 * Test-only synthetic TTY for B.3.5 hidden secret entry.
 * Productive code must never import this module.
 */

import type { HiddenTtyTerminal } from "../../tools/trustforge/buyer-hidden-tty-terminal";

export interface SyntheticHiddenTtyControls {
  readonly terminal: HiddenTtyTerminal;
  readonly safeOutput: string[];
  readonly rawModeEnableCount: { value: number };
  readonly rawModeDisableCount: { value: number };
  enqueueBytes(bytes: Iterable<number>): void;
  enqueueHexKeyThenEnter(hex: string): void;
  enqueueCtrlC(): void;
  enqueueEscape(): void;
  close(): void;
  failNextReadWithTimeout(): void;
}

export function createSyntheticHiddenTty(options?: {
  readonly isTTY?: boolean;
}): SyntheticHiddenTtyControls {
  const isTTY = options?.isTTY !== false;
  const queue: Array<number | null | "TIMEOUT"> = [];
  const safeOutput: string[] = [];
  let rawMode = false;
  const rawModeEnableCount = { value: 0 };
  const rawModeDisableCount = { value: 0 };
  const waiters: Array<(v: number | null | "TIMEOUT") => void> = [];

  const push = (v: number | null | "TIMEOUT") => {
    const waiter = waiters.shift();
    if (waiter) waiter(v);
    else queue.push(v);
  };

  const terminal: HiddenTtyTerminal = {
    get isTTY() {
      return isTTY;
    },
    getRawMode() {
      return rawMode;
    },
    setRawMode(enabled: boolean) {
      if (enabled && !rawMode) rawModeEnableCount.value += 1;
      if (!enabled && rawMode) rawModeDisableCount.value += 1;
      rawMode = enabled;
    },
    writeSafe(text: string) {
      safeOutput.push(text);
    },
    async readByte(_timeoutMs?: number): Promise<number | null> {
      void _timeoutMs;
      if (queue.length > 0) {
        const next = queue.shift()!;
        if (next === "TIMEOUT") {
          throw new Error("BLOCKED_B35_SECRET_ENTRY_TIMEOUT: secret entry timed out");
        }
        return next;
      }
      return new Promise((resolve, reject) => {
        waiters.push((v) => {
          if (v === "TIMEOUT") {
            reject(new Error("BLOCKED_B35_SECRET_ENTRY_TIMEOUT: secret entry timed out"));
            return;
          }
          resolve(v);
        });
      });
    },
  };

  return {
    terminal,
    safeOutput,
    rawModeEnableCount,
    rawModeDisableCount,
    enqueueBytes(bytes) {
      for (const b of bytes) push(b);
    },
    enqueueHexKeyThenEnter(hex) {
      for (const ch of hex) {
        push(ch.charCodeAt(0));
      }
      push(0x0d);
    },
    enqueueCtrlC() {
      push(0x03);
    },
    enqueueEscape() {
      push(0x1b);
    },
    close() {
      push(null);
    },
    failNextReadWithTimeout() {
      push("TIMEOUT");
    },
  };
}
