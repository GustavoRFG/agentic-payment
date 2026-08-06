/**
 * run-trustforge-b2-prepare-only — prepare-only CLI (no real signer, no send).
 *
 * This dispatch does not run the CLI live. Offline fixture tests cover the path.
 * Fresh unsigned 402 must be supplied as an injected observation artifact; this
 * tool does not perform live network I/O.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { runB2PrepareOnly } from "./trustforge/b2-prepare-only-runner";
import type { SellerRequirementsObservation } from "./trustforge/x402-seller-requirements-binding";
import { readFileSync, existsSync } from "node:fs";

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

async function main(): Promise<number> {
  const runDir = readArg("--run-dir");
  const observationPath = readArg("--paytime-observation");
  if (!runDir || !observationPath) {
    console.error(
      "Usage: tsx tools/run-trustforge-b2-prepare-only.ts --run-dir <path> --paytime-observation <path> [--attempt-id <id>]",
    );
    console.error(
      "Stops at BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED. Does not load keys, sign, or send.",
    );
    return 1;
  }
  if (!existsSync(observationPath)) {
    console.error(`BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING: paytime observation missing: ${observationPath}`);
    return 1;
  }
  const paytimeObservation = JSON.parse(
    readFileSync(observationPath, "utf8"),
  ) as SellerRequirementsObservation;
  const attemptId = readArg("--attempt-id") ?? `attempt_${Date.now()}`;
  const attemptDir = join(runDir, "buyer_authorization", attemptId);
  mkdirSync(attemptDir, { recursive: true });
  const result = runB2PrepareOnly({
    runDir,
    attemptDir,
    runId: runDir.split(/[\\/]/).pop() ?? "run",
    attemptId,
    paytimeObservation,
  });
  console.log(`blocker: ${result.blocker}`);
  console.log(`detail: ${result.detail}`);
  console.log(`real_signer_invoked: ${result.real_signer_invoked ? "yes" : "no"}`);
  console.log(`sent: ${result.sent ? "yes" : "no"}`);
  if (result.prepare) {
    console.log(`unsigned_artifact_sha256: ${result.prepare.unsigned_artifact_sha256}`);
    console.log(`stopped_at: ${result.prepare.stopped_at}`);
  }
  // Never print nonce, signature, or full payload.
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
