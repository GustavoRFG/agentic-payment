/**
 * trustforge:registry:refresh-unpaid — re-observe all registered services with
 * UNPAID x402 handshakes and write a refresh report. Updates the registry's
 * per-service `last_refresh` + `observed_at_utc` in place. No wallet, no payment.
 *
 * Usage:
 *   npm run trustforge:registry:refresh-unpaid -- [--run-id <id>] [--out-dir <dir>] [--no-write-registry]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertValid, readJson, repoPath } from "./trustforge/contracts";
import {
  refreshRegistryUnpaid,
  type RegistryDocument,
} from "./trustforge/refresh-registry-unpaid";

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function timestamp(date: Date): string {
  const pad = (v: number) => v.toString().padStart(2, "0");
  return [
    date.getUTCFullYear().toString(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "_",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

async function main(): Promise<number> {
  const now = new Date();
  const runId = arg("--run-id") ?? `registry_refresh_${timestamp(now)}`;
  const registryPath = repoPath("trustforge", "registry", "services.bootstrap.json");
  const registry = readJson(registryPath) as RegistryDocument;

  const outDir =
    arg("--out-dir") ?? repoPath("trustforge", "runtime", "registry-refresh", runId);
  mkdirSync(outDir, { recursive: true });

  const { report, updatedRegistry } = await refreshRegistryUnpaid(registry, runId);

  writeFileSync(
    join(outDir, "refresh_report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  if (arg("--no-write-registry") === undefined) {
    // Validate updated registry against the contract before persisting.
    assertValid("service_registry", updatedRegistry);
    writeFileSync(registryPath, `${JSON.stringify(updatedRegistry, null, 2)}\n`, "utf8");
  }

  console.log("RESULT: PASS");
  console.log(`run_id: ${runId}`);
  console.log(`services_total: ${report.services_total}`);
  console.log(`services_live_402: ${report.services_live_402}`);
  console.log(`services_changed: ${report.services_changed}`);
  console.log(`services_failed: ${report.services_failed}`);
  console.log(`services_skipped: ${report.services_skipped}`);
  for (const o of report.observations) {
    console.log(
      `  - ${o.service_id}: ${o.refresh_status} http=${o.http_status ?? "null"} ` +
        `quote=${o.observed_quote_usdc ?? "null"} net=${o.observed_network ?? "null"} ` +
        `cap=${o.quote_within_cap ?? "null"} latency_ms=${o.latency_ms ?? "null"}`,
    );
  }
  console.log(`report: ${join(outDir, "refresh_report.json")}`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`[trustforge-registry-refresh] error: ${(error as Error).message}`);
    process.exitCode = 1;
  });
