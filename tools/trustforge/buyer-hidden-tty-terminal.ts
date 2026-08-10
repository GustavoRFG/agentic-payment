/**
 * buyer-hidden-tty-terminal — narrow injectable terminal surface for hidden entry.
 *
 * Productive code depends on this interface; tests inject a synthetic TTY.
 * No clipboard APIs. No shell.
 */

export interface HiddenTtyTerminal {
  readonly isTTY: boolean;
  /** Capture whether raw mode was previously enabled. */
  getRawMode(): boolean;
  setRawMode(enabled: boolean): void;
  /** Safe prompt/status only — never credential bytes. */
  writeSafe(text: string): void;
  /**
   * Read one input byte. Returns null on EOF/close.
   * Implementations must not echo when raw mode is enabled.
   */
  readByte(timeoutMs?: number): Promise<number | null>;
}

/** Production Node stdin adapter — only used when access is authorized later. */
export function createNodeProcessHiddenTtyTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): HiddenTtyTerminal {
  return {
    get isTTY() {
      return Boolean(stdin.isTTY);
    },
    getRawMode() {
      return Boolean((stdin as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);
    },
    setRawMode(enabled: boolean) {
      if (typeof stdin.setRawMode === "function") {
        stdin.setRawMode(enabled);
      }
    },
    writeSafe(text: string) {
      stdout.write(text);
    },
    async readByte(timeoutMs = 120_000): Promise<number | null> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("BLOCKED_B35_SECRET_ENTRY_TIMEOUT: secret entry timed out"));
        }, timeoutMs);

        const onData = (chunk: Buffer | string) => {
          cleanup();
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (buf.length === 0) {
            resolve(null);
            return;
          }
          // Only consume one byte per call; push remainder back if possible.
          const first = buf[0]!;
          if (buf.length > 1 && typeof (stdin as { unshift?: (b: Buffer) => void }).unshift === "function") {
            (stdin as { unshift: (b: Buffer) => void }).unshift(buf.subarray(1));
          }
          resolve(first);
        };
        const onEnd = () => {
          cleanup();
          resolve(null);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const cleanup = () => {
          clearTimeout(timer);
          stdin.off("data", onData);
          stdin.off("end", onEnd);
          stdin.off("error", onError);
        };
        stdin.once("data", onData);
        stdin.once("end", onEnd);
        stdin.once("error", onError);
        if (stdin.isPaused()) stdin.resume();
      });
    },
  };
}
