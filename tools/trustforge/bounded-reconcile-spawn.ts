/**
 * bounded-reconcile-spawn — spawn Python reconciler with process deadline.
 */

import { spawnSync } from "node:child_process";

export interface BoundedReconcileOptions {
  readonly repoRoot: string;
  readonly pythonArgs: readonly string[];
  readonly maxTotalRuntimeSeconds: number;
  readonly env?: Record<string, string | undefined>;
}

export interface BoundedReconcileResult {
  readonly ok: boolean;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export function runBoundedPythonReconcile(
  options: BoundedReconcileOptions,
): BoundedReconcileResult {
  const timeoutMs = Math.max(1, options.maxTotalRuntimeSeconds) * 1000;
  const child = spawnSync("python", [...options.pythonArgs], {
    cwd: options.repoRoot,
    env: {
      ...process.env,
      ...options.env,
      BUYER_PRIVATE_KEY: "",
      SEPOLIA_BUYER_PRIVATE_KEY: "",
    },
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGTERM",
  });
  const timedOut = child.error?.message.includes("ETIMEDOUT") ?? false;
  return {
    ok: !timedOut && child.status === 0,
    timedOut,
    exitCode: child.status,
    signal: child.signal,
    stderr: child.stderr ?? "",
  };
}
