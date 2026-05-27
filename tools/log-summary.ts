import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

interface ParsedLog {
  path: string;
  exists: boolean;
  malformedLines: number;
  events: JsonRecord[];
}

interface RecentEvent {
  timestamp: string | null;
  eventType: string;
  requestId: string | null;
  statusCode: number | null;
  path: string | null;
}

interface RecentReport {
  timestamp: string | null;
  requestId: string | null;
  reportId: string | null;
  mode: string | null;
  riskScore: number | null;
  riskLevel: string | null;
  recommendation: string | null;
}

interface RecentError {
  source: "seller" | "buyer";
  timestamp: string | null;
  eventType: string;
  requestId: string | null;
  message: string | null;
}

const SUSPICIOUS_KEY_PARTS = [
  "privatekey",
  "authorization",
  "cookie",
  "paymentheader",
  "signature",
  "secret",
];

const DEFAULT_LIMIT = 5;

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseArgs(argv: string[]): { json: boolean; limit: number } {
  let json = false;
  let limit = DEFAULT_LIMIT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--limit") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        limit = parsed;
      }
      index += 1;
    }
  }

  return { json, limit };
}

function readJsonl(path: string): ParsedLog {
  if (!existsSync(path)) {
    return { path, exists: false, malformedLines: 0, events: [] };
  }

  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return { path, exists: true, malformedLines: 1, events: [] };
  }

  let malformedLines = 0;
  const events: JsonRecord[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) {
        events.push(parsed);
      } else {
        malformedLines += 1;
      }
    } catch {
      malformedLines += 1;
    }
  }

  return { path, exists: true, malformedLines, events };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asStatusCode(value: unknown): number | null {
  const number = asNumber(value);
  return number === null ? null : Math.trunc(number);
}

function eventType(event: JsonRecord): string {
  return asString(event.eventType) ?? "unknown";
}

function increment(map: Record<string, number>, key: string | null | undefined): void {
  if (!key) {
    return;
  }
  map[key] = (map[key] ?? 0) + 1;
}

function countByEvent(events: JsonRecord[], type: string): number {
  return events.filter((event) => eventType(event) === type).length;
}

function countByStatus(events: JsonRecord[], statusCode: number): number {
  return events.filter((event) => asStatusCode(event.statusCode) === statusCode).length;
}

function paymentOf(event: JsonRecord): JsonRecord | undefined {
  return asRecord(event.payment);
}

function reportOf(event: JsonRecord): JsonRecord | undefined {
  return asRecord(event.report);
}

function isSuspiciousKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SUSPICIOUS_KEY_PARTS.some((part) => normalized.includes(part));
}

function countSuspiciousFields(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countSuspiciousFields(item), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }

  let count = 0;
  for (const [key, nested] of Object.entries(value)) {
    if (isSuspiciousKey(key)) {
      count += 1;
      continue;
    }
    count += countSuspiciousFields(nested);
  }
  return count;
}

function safeText(value: unknown, maxLength = 160): string | null {
  const text = asString(value);
  if (!text) {
    return null;
  }
  const lower = text.toLowerCase();
  if (
    lower.includes("authorization") ||
    lower.includes("cookie") ||
    lower.includes("paymentheader") ||
    lower.includes("privatekey") ||
    lower.includes("signature") ||
    lower.includes("secret")
  ) {
    return "[redacted suspicious text]";
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function toRecentEvent(event: JsonRecord): RecentEvent {
  return {
    timestamp: asString(event.timestamp),
    eventType: eventType(event),
    requestId: asString(event.requestId),
    statusCode: asStatusCode(event.statusCode),
    path: safeText(event.path, 80),
  };
}

function toRecentReport(event: JsonRecord): RecentReport {
  const report = reportOf(event);
  return {
    timestamp: asString(event.timestamp),
    requestId: asString(event.requestId),
    reportId: report ? safeText(report.reportId, 80) : null,
    mode: report ? safeText(report.mode, 80) : null,
    riskScore: report ? asNumber(report.riskScore) : null,
    riskLevel: report ? safeText(report.riskLevel, 80) : null,
    recommendation: report ? safeText(report.recommendation, 120) : null,
  };
}

function toRecentError(source: "seller" | "buyer", event: JsonRecord): RecentError {
  const error = asRecord(event.error);
  return {
    source,
    timestamp: asString(event.timestamp),
    eventType: eventType(event),
    requestId: asString(event.requestId),
    message: error ? safeText(error.message) : null,
  };
}

function lastItems<T>(items: T[], limit: number): T[] {
  if (limit <= 0) {
    return [];
  }
  return items.slice(Math.max(items.length - limit, 0)).reverse();
}

function average(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(2));
}

function inferPaidReport(event: JsonRecord): boolean {
  const report = reportOf(event);
  const payment = paymentOf(event);
  const mode = `${asString(report?.mode) ?? ""} ${asString(payment?.mode) ?? ""}`.toLowerCase();
  return mode.includes("paid") || mode.includes("accepted");
}

function inferMockReport(event: JsonRecord): boolean {
  const report = reportOf(event);
  const mode = (asString(report?.mode) ?? "").toLowerCase();
  return mode.includes("mock");
}

function buildSummary(seller: ParsedLog, buyer: ParsedLog, limit: number) {
  const sellerEvents = seller.events;
  const buyerEvents = buyer.events;
  const allEvents = [...sellerEvents, ...buyerEvents];

  const reportEvents = sellerEvents.filter((event) => eventType(event) === "seller.report_generated");
  const riskScores = reportEvents
    .map((event) => asNumber(reportOf(event)?.riskScore))
    .filter((value): value is number => value !== null);

  const riskLevelCounts: Record<string, number> = {};
  const recommendationCounts: Record<string, number> = {};
  for (const event of reportEvents) {
    const report = reportOf(event);
    increment(riskLevelCounts, safeText(report?.riskLevel, 80));
    increment(recommendationCounts, safeText(report?.recommendation, 120));
  }

  const networkCounts: Record<string, number> = {};
  const assetCounts: Record<string, number> = {};
  const amountAtomicCounts: Record<string, number> = {};
  const amountUsdCounts: Record<string, number> = {};
  for (const event of allEvents) {
    const payment = paymentOf(event);
    if (!payment) {
      continue;
    }
    increment(networkCounts, safeText(payment.network, 80));
    increment(assetCounts, safeText(payment.asset, 80));
    increment(amountAtomicCounts, safeText(payment.amountAtomic, 80));
    increment(amountUsdCounts, safeText(payment.amountUsd, 80));
  }

  const sellerRequestIds = new Set(sellerEvents.map((event) => asString(event.requestId)).filter(Boolean));
  const buyerRequestIds = new Set(buyerEvents.map((event) => asString(event.requestId)).filter(Boolean));
  const dryRunRequestIds = new Set(
    buyerEvents
      .filter((event) => event.dryRun === true)
      .map((event) => asString(event.requestId))
      .filter(Boolean),
  );
  const allRequestIds = new Set([...sellerRequestIds, ...buyerRequestIds]);
  const correlatedRequestIds = [...sellerRequestIds].filter((requestId) => buyerRequestIds.has(requestId)).length;

  const requestsByWalletSets = new Map<string, Set<string>>();
  for (const event of sellerEvents) {
    const wallet = safeText(event.wallet, 80);
    const requestId = asString(event.requestId);
    if (!wallet || !requestId) {
      continue;
    }
    const requestIds = requestsByWalletSets.get(wallet) ?? new Set<string>();
    requestIds.add(requestId);
    requestsByWalletSets.set(wallet, requestIds);
  }

  const requestsByWallet: Record<string, number> = {};
  for (const [wallet, requestIds] of requestsByWalletSets.entries()) {
    requestsByWallet[wallet] = requestIds.size;
  }

  const errorEvents = [
    ...sellerEvents
      .filter((event) => eventType(event) === "seller.error" || Boolean(event.error))
      .map((event) => toRecentError("seller", event)),
    ...buyerEvents
      .filter((event) => eventType(event) === "buyer.error" || Boolean(event.error))
      .map((event) => toRecentError("buyer", event)),
  ].sort((left, right) => (left.timestamp ?? "").localeCompare(right.timestamp ?? ""));

  return {
    title: "Agentic Payments Lab  Local Audit Summary",
    generatedAt: new Date().toISOString(),
    files: {
      seller: { path: seller.path, exists: seller.exists },
      buyer: { path: buyer.path, exists: buyer.exists },
    },
    malformedLines: {
      seller: seller.malformedLines,
      buyer: buyer.malformedLines,
    },
    redactionWarnings: {
      suspiciousFieldCount: allEvents.reduce((total, event) => total + countSuspiciousFields(event), 0),
    },
    seller: {
      totalEvents: sellerEvents.length,
      requestReceived: countByEvent(sellerEvents, "seller.request_received"),
      paymentRequired: countByEvent(sellerEvents, "seller.payment_required"),
      reportGenerated: countByEvent(sellerEvents, "seller.report_generated"),
      responseFinished: countByEvent(sellerEvents, "seller.response_finished"),
      error: countByEvent(sellerEvents, "seller.error"),
      http200: countByStatus(sellerEvents, 200),
      http402: countByStatus(sellerEvents, 402),
      http500: countByStatus(sellerEvents, 500),
    },
    buyer: {
      totalEvents: buyerEvents.length,
      requestStarted: countByEvent(buyerEvents, "buyer.request_started"),
      paymentRequirementsReceived: countByEvent(buyerEvents, "buyer.payment_requirements_received"),
      dryRunCompleted: countByEvent(buyerEvents, "buyer.dry_run_completed"),
      error: countByEvent(buyerEvents, "buyer.error"),
      dryRun: dryRunRequestIds.size,
    },
    reports: {
      totalGenerated: reportEvents.length,
      paidReports: reportEvents.length === 0 ? null : reportEvents.filter(inferPaidReport).length,
      mockReports: reportEvents.length === 0 ? null : reportEvents.filter(inferMockReport).length,
      averageRiskScore: rounded(average(riskScores)),
      minRiskScore: riskScores.length === 0 ? null : Math.min(...riskScores),
      maxRiskScore: riskScores.length === 0 ? null : Math.max(...riskScores),
      riskLevelCounts,
      recommendationCounts,
    },
    payments: {
      total402Offers: countByEvent(sellerEvents, "seller.payment_required"),
      totalDryRunOutcomes: countByEvent(buyerEvents, "buyer.dry_run_completed"),
      networkCounts,
      assetCounts,
      amountAtomicCounts,
      amountUsdCounts,
    },
    identity: {
      uniqueRequestIds: allRequestIds.size,
      uniqueWallets: requestsByWalletSets.size,
      requestsByWallet,
      correlatedBuyerSellerRequestIds: correlatedRequestIds,
    },
    recent: {
      sellerEvents: lastItems(sellerEvents.map(toRecentEvent), limit),
      buyerEvents: lastItems(buyerEvents.map(toRecentEvent), limit),
      generatedReports: lastItems(reportEvents.map(toRecentReport), limit),
      errors: lastItems(errorEvents, limit),
    },
  };
}

function formatNumber(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

function formatMap(map: Record<string, number>): string[] {
  const entries = Object.entries(map).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) {
    return ["  - n/a"];
  }
  return entries.map(([key, count]) => `  - ${key}: ${count}`);
}

function formatRecentEvent(event: RecentEvent): string {
  const parts = [
    event.timestamp ?? "n/a",
    event.eventType,
    event.requestId ? `requestId=${event.requestId}` : "requestId=n/a",
  ];
  if (event.statusCode !== null) {
    parts.push(`status=${event.statusCode}`);
  }
  if (event.path) {
    parts.push(`path=${event.path}`);
  }
  return `  - ${parts.join(" | ")}`;
}

function formatRecentReport(report: RecentReport): string {
  return [
    `  - ${report.timestamp ?? "n/a"}`,
    report.requestId ? `requestId=${report.requestId}` : "requestId=n/a",
    report.reportId ? `reportId=${report.reportId}` : "reportId=n/a",
    report.mode ? `mode=${report.mode}` : "mode=n/a",
    report.riskScore !== null ? `risk=${report.riskScore}` : "risk=n/a",
    report.riskLevel ? `level=${report.riskLevel}` : "level=n/a",
    report.recommendation ? `recommendation=${report.recommendation}` : "recommendation=n/a",
  ].join(" | ");
}

function formatRecentError(error: RecentError): string {
  return [
    `  - ${error.timestamp ?? "n/a"}`,
    error.source,
    error.eventType,
    error.requestId ? `requestId=${error.requestId}` : "requestId=n/a",
    error.message ? `message=${error.message}` : "message=n/a",
  ].join(" | ");
}

function printHuman(summary: ReturnType<typeof buildSummary>): void {
  console.log(summary.title);
  console.log("");
  console.log("Files:");
  console.log(`- seller log path: ${summary.files.seller.path}`);
  console.log(`- seller log exists: ${summary.files.seller.exists}`);
  console.log(`- buyer log path: ${summary.files.buyer.path}`);
  console.log(`- buyer log exists: ${summary.files.buyer.exists}`);
  console.log(`- Malformed seller log lines: ${summary.malformedLines.seller}`);
  console.log(`- Malformed buyer log lines: ${summary.malformedLines.buyer}`);
  console.log(`- Redaction warnings: ${summary.redactionWarnings.suspiciousFieldCount}`);
  console.log("");
  console.log("Seller:");
  console.log(`- total seller events: ${summary.seller.totalEvents}`);
  console.log(`- seller.request_received count: ${summary.seller.requestReceived}`);
  console.log(`- seller.payment_required count: ${summary.seller.paymentRequired}`);
  console.log(`- seller.report_generated count: ${summary.seller.reportGenerated}`);
  console.log(`- seller.response_finished count: ${summary.seller.responseFinished}`);
  console.log(`- seller.error count: ${summary.seller.error}`);
  console.log(`- HTTP 200 count: ${summary.seller.http200}`);
  console.log(`- HTTP 402 count: ${summary.seller.http402}`);
  console.log(`- HTTP 500 count: ${summary.seller.http500}`);
  console.log("");
  console.log("Buyer:");
  console.log(`- total buyer events: ${summary.buyer.totalEvents}`);
  console.log(`- buyer.request_started count: ${summary.buyer.requestStarted}`);
  console.log(`- buyer.payment_requirements_received count: ${summary.buyer.paymentRequirementsReceived}`);
  console.log(`- buyer.dry_run_completed count: ${summary.buyer.dryRunCompleted}`);
  console.log(`- buyer.error count: ${summary.buyer.error}`);
  console.log(`- dry-run count: ${summary.buyer.dryRun}`);
  console.log("");
  console.log("Reports:");
  console.log(`- total reports generated: ${summary.reports.totalGenerated}`);
  console.log(`- paid reports if inferable: ${formatNumber(summary.reports.paidReports)}`);
  console.log(`- mock reports if inferable: ${formatNumber(summary.reports.mockReports)}`);
  console.log(`- average risk score: ${formatNumber(summary.reports.averageRiskScore)}`);
  console.log(`- min risk score: ${formatNumber(summary.reports.minRiskScore)}`);
  console.log(`- max risk score: ${formatNumber(summary.reports.maxRiskScore)}`);
  console.log("- risk level counts:");
  console.log(formatMap(summary.reports.riskLevelCounts).join("\n"));
  console.log("- recommendation counts:");
  console.log(formatMap(summary.reports.recommendationCounts).join("\n"));
  console.log("");
  console.log("Payments:");
  console.log(`- total 402 offers: ${summary.payments.total402Offers}`);
  console.log(`- total dry-run outcomes: ${summary.payments.totalDryRunOutcomes}`);
  console.log("- network counts:");
  console.log(formatMap(summary.payments.networkCounts).join("\n"));
  console.log("- asset counts:");
  console.log(formatMap(summary.payments.assetCounts).join("\n"));
  console.log("- amountAtomic counts:");
  console.log(formatMap(summary.payments.amountAtomicCounts).join("\n"));
  console.log("- amountUsd counts:");
  console.log(formatMap(summary.payments.amountUsdCounts).join("\n"));
  console.log("");
  console.log("Wallets / request identity:");
  console.log(`- unique request IDs: ${summary.identity.uniqueRequestIds}`);
  console.log(`- unique wallets: ${summary.identity.uniqueWallets}`);
  console.log("- requests by wallet:");
  console.log(formatMap(summary.identity.requestsByWallet).join("\n"));
  console.log(`- correlated buyer/seller request IDs count: ${summary.identity.correlatedBuyerSellerRequestIds}`);
  console.log("");
  console.log("Recent activity:");
  console.log("- last seller events:");
  console.log((summary.recent.sellerEvents.length ? summary.recent.sellerEvents.map(formatRecentEvent) : ["  - n/a"]).join("\n"));
  console.log("- last buyer events:");
  console.log((summary.recent.buyerEvents.length ? summary.recent.buyerEvents.map(formatRecentEvent) : ["  - n/a"]).join("\n"));
  console.log("- last generated reports:");
  console.log((summary.recent.generatedReports.length ? summary.recent.generatedReports.map(formatRecentReport) : ["  - n/a"]).join("\n"));
  console.log("- last errors:");
  console.log((summary.recent.errors.length ? summary.recent.errors.map(formatRecentError) : ["  - n/a"]).join("\n"));
}

const args = parseArgs(process.argv.slice(2));
const root = projectRoot();
const sellerLog = readJsonl(join(root, "logs", "seller-events.jsonl"));
const buyerLog = readJsonl(join(root, "logs", "buyer-events.jsonl"));
const summary = buildSummary(sellerLog, buyerLog, args.limit);

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  printHuman(summary);
}
