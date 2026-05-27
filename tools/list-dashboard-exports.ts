import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface DashboardExportEntry {
  id?: unknown;
  path?: unknown;
  summary?: {
    sellerEvents?: unknown;
    buyerEvents?: unknown;
    total402Offers?: unknown;
    dryRuns?: unknown;
    reportsGenerated?: unknown;
  };
}

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function asNumber(value: unknown): number | string {
  return typeof value === "number" && Number.isFinite(value) ? value : "n/a";
}

function loadExports(path: string): DashboardExportEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const manifestPath = join(projectRoot(), "dashboard", "exports", "exports.json");
const entries = loadExports(manifestPath)
  .filter((entry) => typeof entry.id === "string" && typeof entry.path === "string")
  .sort((left, right) => String(right.id).localeCompare(String(left.id)));

if (entries.length === 0) {
  console.log("No dashboard exports found.");
} else {
  console.log("Dashboard Exports");
  for (const entry of entries) {
    const summary = entry.summary ?? {};
    console.log(
      `- ${entry.id} | seller=${asNumber(summary.sellerEvents)} buyer=${asNumber(summary.buyerEvents)} 402=${asNumber(summary.total402Offers)} dryRuns=${asNumber(summary.dryRuns)} reports=${asNumber(summary.reportsGenerated)} | ${entry.path}`,
    );
  }
}
