import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAuditSummary, type AuditSummary } from "./log-summary.ts";
import { renderDashboardFile } from "./render-dashboard.ts";

interface DashboardExportEntry {
  id: string;
  createdAt: string;
  path: string;
  source: string;
  summary: {
    sellerEvents: number;
    buyerEvents: number;
    total402Offers: number;
    dryRuns: number;
    reportsGenerated: number;
  };
}

const DASHBOARD_RELATIVE_PATH = "dashboard/index.html";
const EXPORTS_RELATIVE_DIR = "dashboard/exports";

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function timestampId(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    "-",
    pad(date.getMinutes()),
    "-",
    pad(date.getSeconds()),
  ].join("");
}

function toRepoPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).replace(/\\/g, "/");
}

function loadManifest(path: string): DashboardExportEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is DashboardExportEntry => {
      return typeof entry === "object" && entry !== null && typeof (entry as { id?: unknown }).id === "string";
    });
  } catch {
    return [];
  }
}

function compactSummary(summary: AuditSummary): DashboardExportEntry["summary"] {
  return {
    sellerEvents: summary.seller.totalEvents,
    buyerEvents: summary.buyer.totalEvents,
    total402Offers: summary.payments.total402Offers,
    dryRuns: summary.buyer.dryRun,
    reportsGenerated: summary.reports.totalGenerated,
  };
}

function ensureDashboard(root: string, sourcePath: string): void {
  if (existsSync(sourcePath)) {
    return;
  }
  renderDashboardFile({
    limit: 10,
    outputPath: sourcePath,
  });
}

function main(): number {
  const root = projectRoot();
  const sourcePath = join(root, DASHBOARD_RELATIVE_PATH);
  const exportsDir = join(root, EXPORTS_RELATIVE_DIR);
  const manifestPath = join(exportsDir, "exports.json");
  const now = new Date();
  const id = timestampId(now);
  const exportDir = join(exportsDir, id);
  const exportPath = join(exportDir, "index.html");

  ensureDashboard(root, sourcePath);
  mkdirSync(exportDir, { recursive: true });
  copyFileSync(sourcePath, exportPath);

  const summary = buildAuditSummary({ limit: 5 });
  const entry: DashboardExportEntry = {
    id,
    createdAt: now.toISOString(),
    path: toRepoPath(root, exportPath),
    source: DASHBOARD_RELATIVE_PATH,
    summary: compactSummary(summary),
  };

  const manifest = loadManifest(manifestPath).filter((existing) => existing.id !== id);
  manifest.push(entry);
  manifest.sort((left, right) => left.id.localeCompare(right.id));
  mkdirSync(exportsDir, { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log("Agentic Payments Lab  dashboard export created");
  console.log(`- id: ${entry.id}`);
  console.log(`- output: ${entry.path}`);
  console.log(`- manifest: ${toRepoPath(root, manifestPath)}`);
  console.log(
    `- summary: seller=${entry.summary.sellerEvents} buyer=${entry.summary.buyerEvents} 402=${entry.summary.total402Offers} dryRuns=${entry.summary.dryRuns} reports=${entry.summary.reportsGenerated}`,
  );

  return 0;
}

raise();

function raise(): void {
  process.exitCode = main();
}
