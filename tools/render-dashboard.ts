import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildAuditSummary, type AuditSummary } from "./log-summary.ts";

const DEFAULT_RECENT_LIMIT = 10;
const DEFAULT_OUTPUT_RELATIVE = "dashboard/index.html";

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export interface RenderOptions {
  limit: number;
  outputPath: string;
}

function parseArgs(argv: string[]): RenderOptions {
  let limit = DEFAULT_RECENT_LIMIT;
  let outputPath = join(projectRoot(), DEFAULT_OUTPUT_RELATIVE);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        limit = parsed;
      }
      index += 1;
      continue;
    }
    if (arg === "--out") {
      const next = argv[index + 1];
      if (next && next.length > 0) {
        outputPath = resolve(next);
      }
      index += 1;
      continue;
    }
  }

  return { limit, outputPath };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "n/a";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "n/a";
  }
  const text = String(value);
  return text.length === 0 ? "n/a" : escapeHtml(text);
}

function fmtMono(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return `<span class="mono muted">n/a</span>`;
  }
  return `<span class="mono">${fmt(value)}</span>`;
}

function kpiCard(label: string, value: string | number | null | undefined, hint?: string): string {
  const hintHtml = hint ? `<div class="kpi-hint">${escapeHtml(hint)}</div>` : "";
  return `
    <div class="card kpi">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value">${fmt(value)}</div>
      ${hintHtml}
    </div>
  `;
}

function renderMap(map: Record<string, number> | undefined): string {
  if (!map) {
    return `<div class="empty">n/a</div>`;
  }
  const entries = Object.entries(map);
  if (entries.length === 0) {
    return `<div class="empty">n/a</div>`;
  }
  entries.sort(([leftKey, leftCount], [rightKey, rightCount]) => {
    if (rightCount !== leftCount) {
      return rightCount - leftCount;
    }
    return leftKey.localeCompare(rightKey);
  });
  const rows = entries
    .map(
      ([key, count]) => `
        <tr>
          <td class="mono">${fmt(key)}</td>
          <td class="right">${fmt(count)}</td>
        </tr>`,
    )
    .join("");
  return `
    <table class="kv">
      <thead><tr><th>Value</th><th class="right">Count</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderRecentEvents(events: AuditSummary["recent"]["sellerEvents"]): string {
  if (events.length === 0) {
    return `<div class="empty">No events yet.</div>`;
  }
  const rows = events
    .map(
      (event) => `
        <tr>
          <td class="mono nowrap">${fmt(event.timestamp)}</td>
          <td>${fmt(event.eventType)}</td>
          <td class="mono">${fmt(event.requestId)}</td>
          <td class="right mono">${fmt(event.statusCode)}</td>
          <td class="mono">${fmt(event.path)}</td>
        </tr>`,
    )
    .join("");
  return `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Event</th>
          <th>Request ID</th>
          <th class="right">Status</th>
          <th>Path</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderRecentReports(reports: AuditSummary["recent"]["generatedReports"]): string {
  if (reports.length === 0) {
    return `<div class="empty">No reports generated yet.</div>`;
  }
  const rows = reports
    .map(
      (report) => `
        <tr>
          <td class="mono nowrap">${fmt(report.timestamp)}</td>
          <td class="mono">${fmt(report.requestId)}</td>
          <td class="mono">${fmt(report.reportId)}</td>
          <td>${fmt(report.mode)}</td>
          <td class="right mono">${fmt(report.riskScore)}</td>
          <td>${fmt(report.riskLevel)}</td>
          <td>${fmt(report.recommendation)}</td>
        </tr>`,
    )
    .join("");
  return `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Request ID</th>
          <th>Report ID</th>
          <th>Mode</th>
          <th class="right">Risk</th>
          <th>Level</th>
          <th>Recommendation</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderRecentErrors(errors: AuditSummary["recent"]["errors"]): string {
  if (errors.length === 0) {
    return `<div class="empty">No errors recorded.</div>`;
  }
  const rows = errors
    .map(
      (error) => `
        <tr>
          <td class="mono nowrap">${fmt(error.timestamp)}</td>
          <td>${fmt(error.source)}</td>
          <td>${fmt(error.eventType)}</td>
          <td class="mono">${fmt(error.requestId)}</td>
          <td>${fmt(error.message)}</td>
        </tr>`,
    )
    .join("");
  return `
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Source</th>
          <th>Event</th>
          <th>Request ID</th>
          <th>Message</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

const CSS = `
  :root {
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #0b0f15;
    color: #e4e8ef;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
  }
  .container {
    max-width: 1200px;
    margin: 0 auto;
    padding: 32px 24px 64px 24px;
  }
  header.page {
    border-bottom: 1px solid #1d2430;
    padding-bottom: 16px;
    margin-bottom: 24px;
  }
  header.page h1 {
    margin: 0 0 4px 0;
    font-size: 22px;
    letter-spacing: 0.2px;
  }
  header.page .subtitle {
    color: #9aa4b2;
    font-size: 13px;
  }
  header.page .meta {
    margin-top: 8px;
    color: #707a89;
    font-size: 12px;
  }
  .banner {
    background: #1a1208;
    border: 1px solid #4a2b00;
    color: #f0b97a;
    padding: 10px 14px;
    border-radius: 6px;
    margin-bottom: 24px;
    font-size: 13px;
  }
  section {
    margin-bottom: 32px;
  }
  section > h2 {
    font-size: 14px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #9aa4b2;
    margin: 0 0 12px 0;
  }
  .grid {
    display: grid;
    gap: 12px;
  }
  .kpi-grid {
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  }
  .twocol {
    grid-template-columns: 1fr 1fr;
  }
  .threecol {
    grid-template-columns: repeat(3, 1fr);
  }
  .card {
    background: #121823;
    border: 1px solid #1d2430;
    border-radius: 8px;
    padding: 14px 16px;
  }
  .card h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: #707a89;
    margin: 0 0 8px 0;
  }
  .kpi .kpi-label {
    color: #9aa4b2;
    font-size: 12px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
  }
  .kpi .kpi-value {
    font-size: 26px;
    font-weight: 600;
    color: #f5f7fa;
    margin-top: 6px;
  }
  .kpi .kpi-hint {
    color: #5e6776;
    font-size: 11px;
    margin-top: 4px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  th, td {
    text-align: left;
    padding: 8px 10px;
    border-bottom: 1px solid #1d2430;
    vertical-align: top;
  }
  thead th {
    color: #9aa4b2;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    font-weight: 600;
  }
  tbody tr:hover { background: #161e2c; }
  td.right, th.right { text-align: right; }
  td.nowrap { white-space: nowrap; }
  .mono {
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
  }
  .muted { color: #5e6776; }
  .empty {
    color: #707a89;
    font-size: 12px;
    padding: 10px 4px;
    font-style: italic;
  }
  footer.page {
    border-top: 1px solid #1d2430;
    padding-top: 16px;
    margin-top: 32px;
    color: #5e6776;
    font-size: 12px;
  }
  .files {
    display: flex;
    gap: 24px;
    flex-wrap: wrap;
    font-size: 12px;
    color: #9aa4b2;
  }
  .files .file-row { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .pill {
    display: inline-block;
    border-radius: 10px;
    padding: 2px 8px;
    font-size: 11px;
    letter-spacing: 0.4px;
    text-transform: uppercase;
    background: #1d2430;
    color: #9aa4b2;
    margin-left: 6px;
  }
  .pill.ok { background: #103021; color: #5ec487; }
  .pill.missing { background: #2a1414; color: #d97b7b; }
`;

interface RenderResult {
  outputPath: string;
  html: string;
  hadAnyLogs: boolean;
}

function renderDashboard(summary: AuditSummary): string {
  const sellerExists = summary.files.seller.exists;
  const buyerExists = summary.files.buyer.exists;
  const hadAnyLogs = sellerExists || buyerExists;

  const banner = hadAnyLogs
    ? ""
    : `<div class="banner">No audit logs found yet. Run the seller or buyer once to populate <code>logs/seller-events.jsonl</code> and <code>logs/buyer-events.jsonl</code>.</div>`;

  const kpis = [
    kpiCard("Seller events", summary.seller.totalEvents),
    kpiCard("Buyer events", summary.buyer.totalEvents),
    kpiCard("Total 402 offers", summary.payments.total402Offers),
    kpiCard("Dry-run requests", summary.buyer.dryRun),
    kpiCard("Reports generated", summary.reports.totalGenerated),
    kpiCard("Avg risk score", summary.reports.averageRiskScore),
    kpiCard("Unique request IDs", summary.identity.uniqueRequestIds),
    kpiCard("Correlated buyer/seller IDs", summary.identity.correlatedBuyerSellerRequestIds),
    kpiCard(
      "Malformed log lines",
      summary.malformedLines.seller + summary.malformedLines.buyer,
      `seller=${summary.malformedLines.seller}, buyer=${summary.malformedLines.buyer}`,
    ),
    kpiCard("Errors", summary.seller.error + summary.buyer.error),
  ].join("");

  const sellerExistsPill = sellerExists
    ? `<span class="pill ok">exists</span>`
    : `<span class="pill missing">missing</span>`;
  const buyerExistsPill = buyerExists
    ? `<span class="pill ok">exists</span>`
    : `<span class="pill missing">missing</span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-Content-Type-Options" content="nosniff">
<title>Agentic Payments Lab  Local x402 Audit Dashboard</title>
<style>${CSS}</style>
</head>
<body>
<div class="container">
  <header class="page">
    <h1>Agentic Payments Lab</h1>
    <div class="subtitle">Local x402 Audit Dashboard</div>
    <div class="subtitle">Static local dashboard generated from JSONL audit summaries.</div>
    <div class="meta">Generated at <span class="mono">${fmt(summary.generatedAt)}</span></div>
    <div class="files" style="margin-top:8px;">
      <div class="file-row">seller log: ${escapeHtml(summary.files.seller.path)} ${sellerExistsPill}</div>
      <div class="file-row">buyer log: ${escapeHtml(summary.files.buyer.path)} ${buyerExistsPill}</div>
    </div>
  </header>

  ${banner}

  <section>
    <h2>KPIs</h2>
    <div class="grid kpi-grid">
      ${kpis}
    </div>
  </section>

  <section>
    <h2>Reports</h2>
    <div class="grid threecol">
      <div class="card">
        <h3>Risk scores</h3>
        <table class="kv">
          <tbody>
            <tr><td>Average</td><td class="right">${fmt(summary.reports.averageRiskScore)}</td></tr>
            <tr><td>Min</td><td class="right">${fmt(summary.reports.minRiskScore)}</td></tr>
            <tr><td>Max</td><td class="right">${fmt(summary.reports.maxRiskScore)}</td></tr>
            <tr><td>Total generated</td><td class="right">${fmt(summary.reports.totalGenerated)}</td></tr>
            <tr><td>Paid (inferred)</td><td class="right">${fmt(summary.reports.paidReports)}</td></tr>
            <tr><td>Mock (inferred)</td><td class="right">${fmt(summary.reports.mockReports)}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3>Risk level counts</h3>
        ${renderMap(summary.reports.riskLevelCounts)}
      </div>
      <div class="card">
        <h3>Recommendation counts</h3>
        ${renderMap(summary.reports.recommendationCounts)}
      </div>
    </div>
  </section>

  <section>
    <h2>Payments</h2>
    <div class="grid twocol">
      <div class="card">
        <h3>Networks</h3>
        ${renderMap(summary.payments.networkCounts)}
      </div>
      <div class="card">
        <h3>Assets</h3>
        ${renderMap(summary.payments.assetCounts)}
      </div>
      <div class="card">
        <h3>Amount (atomic)</h3>
        ${renderMap(summary.payments.amountAtomicCounts)}
      </div>
      <div class="card">
        <h3>Amount (USD)</h3>
        ${renderMap(summary.payments.amountUsdCounts)}
      </div>
      <div class="card">
        <h3>Offer / dry-run totals</h3>
        <table class="kv">
          <tbody>
            <tr><td>Total 402 offers</td><td class="right">${fmt(summary.payments.total402Offers)}</td></tr>
            <tr><td>Total dry-run outcomes</td><td class="right">${fmt(summary.payments.totalDryRunOutcomes)}</td></tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3>Identity</h3>
        <table class="kv">
          <tbody>
            <tr><td>Unique request IDs</td><td class="right">${fmt(summary.identity.uniqueRequestIds)}</td></tr>
            <tr><td>Unique wallets</td><td class="right">${fmt(summary.identity.uniqueWallets)}</td></tr>
            <tr><td>Correlated buyer/seller IDs</td><td class="right">${fmt(summary.identity.correlatedBuyerSellerRequestIds)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>

  <section>
    <h2>Recent seller events</h2>
    <div class="card">${renderRecentEvents(summary.recent.sellerEvents)}</div>
  </section>

  <section>
    <h2>Recent buyer events</h2>
    <div class="card">${renderRecentEvents(summary.recent.buyerEvents)}</div>
  </section>

  <section>
    <h2>Recent generated reports</h2>
    <div class="card">${renderRecentReports(summary.recent.generatedReports)}</div>
  </section>

  <section>
    <h2>Recent errors</h2>
    <div class="card">${renderRecentErrors(summary.recent.errors)}</div>
  </section>

  <footer class="page">
    No private keys, CDP secrets, .env contents, raw x402 signatures, or raw payment headers are rendered.
    Dashboard built from sanitized summary fields only.
  </footer>
</div>
</body>
</html>
`;
}

export function renderDashboardFile(options: RenderOptions): RenderResult {
  const summary = buildAuditSummary({ limit: options.limit });
  const html = renderDashboard(summary);
  const outputPath = options.outputPath;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, "utf8");
  return {
    outputPath,
    html,
    hadAnyLogs: summary.files.seller.exists || summary.files.buyer.exists,
  };
}

function run(): RenderResult {
  return renderDashboardFile(parseArgs(process.argv.slice(2)));
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  const result = run();
  console.log("Agentic Payments Lab  dashboard rendered");
  console.log(`- output: ${result.outputPath}`);
  console.log(`- bytes: ${Buffer.byteLength(result.html, "utf8")}`);
  console.log(`- had any logs: ${result.hadAnyLogs}`);
}

export { renderDashboard, run };
