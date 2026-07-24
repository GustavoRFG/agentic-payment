/**
 * abort-deadline — an AbortController with a self-clearing, unref'd timeout.
 *
 * Keyless probes bound their fetch with `setTimeout(() => controller.abort())`.
 * If that timer is left referenced it keeps the event loop — and, under the
 * `singleFork` vitest pool, the whole worker — alive into teardown; when the
 * loop is torn down with the self-pipe still armed, libuv aborts
 * (`Assertion failed: ... async.c`). Unref'ing the timer means the deadline can
 * never hold the loop open, and `clear()` disarms it on the normal path.
 */

export interface AbortDeadline {
  readonly signal: AbortSignal;
  /** Cancel the deadline timer. Safe to call more than once. */
  readonly clear: () => void;
  /** The underlying timer handle (exposed for assertions/tests). */
  readonly timer: ReturnType<typeof setTimeout>;
}

export function startAbortDeadline(timeoutMs: number): AbortDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Never let the deadline timer keep the event loop (or worker) alive.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  let cleared = false;
  return {
    signal: controller.signal,
    clear: () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
    },
    timer,
  };
}
