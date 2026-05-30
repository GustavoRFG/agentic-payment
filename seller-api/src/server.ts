/**
 * Agentic Payments Lab — seller-api (MVP 001).
 *
 * Express server that exposes:
 *   GET  /health                    — public liveness probe
 *   POST /mock/defi-risk-report     — public, returns adapter mock report
 *   POST /paid/defi-risk-report     — x402-protected, returns same adapter
 *
 * The paid endpoint is wired through @x402/express. Until a buyer presents a
 * valid x402 payment, the middleware short-circuits with HTTP 402 and the
 * payment requirements in the body.
 *
 * Strictly testnet (Base Sepolia, eip155:84532). No mainnet, no real funds.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  defiGuardianAdapter,
  validateRiskReportPayload,
} from "./domain/defiGuardianAdapter";
import type { RiskReport, RiskReportRequest } from "./domain/reportTypes";
import { writeSellerAuditEvent } from "./observability/auditLogger";
import type {
  AuditPaymentSummary,
  AuditPositionSummary,
} from "./observability/auditTypes";

dotenv.config();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type Caip2Network = `${string}:${string}`;

const PORT = Number.parseInt(process.env.PORT ?? "4021", 10);
const SELLER_RECEIVER_ADDRESS = process.env.SELLER_RECEIVER_ADDRESS ?? "";
const REPORT_PRICE_USD = process.env.REPORT_PRICE_USD ?? "$0.001";
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const NETWORK = (process.env.X402_NETWORK ?? "eip155:84532") as Caip2Network;
const SELLER_RECEIVER_ADDRESS_TYPED =
  SELLER_RECEIVER_ADDRESS as `0x${string}`;

function assertConfig(): void {
  const problems: string[] = [];
  if (!SELLER_RECEIVER_ADDRESS || !SELLER_RECEIVER_ADDRESS.startsWith("0x")) {
    problems.push(
      "SELLER_RECEIVER_ADDRESS must be a 0x-prefixed Base Sepolia address.",
    );
  }
  if (!REPORT_PRICE_USD.startsWith("$")) {
    problems.push(
      'REPORT_PRICE_USD must start with "$" (e.g. "$0.001"); @x402/express ' +
        "rejects non-dollar-prefixed prices.",
    );
  }
  if (NETWORK !== "eip155:84532") {
    problems.push(
      `X402_NETWORK is "${NETWORK}"; MVP 001 is testnet only (eip155:84532).`,
    );
  }
  if (problems.length > 0) {
    console.error("[seller-api] configuration problems:");
    for (const message of problems) console.error("  - " + message);
    process.exit(1);
  }
}

assertConfig();

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

const REPORT_PATHS = new Set([
  "/mock/defi-risk-report",
  "/paid/defi-risk-report",
]);

function requestIdFromHeader(req: Request): string {
  const incoming = req.header("x-agentic-request-id");
  if (incoming && incoming.length <= 128) return incoming;
  return randomUUID();
}

function walletFromBody(body: RiskReportRequest): string | undefined {
  return typeof body.wallet === "string" ? body.wallet : undefined;
}

function positionFromBody(
  body: RiskReportRequest,
): AuditPositionSummary | undefined {
  if (!body.position || typeof body.position !== "object") return undefined;
  const position = body.position;
  return {
    protocol:
      typeof position.protocol === "string" ? position.protocol : undefined,
    chain: typeof position.chain === "string" ? position.chain : undefined,
    tokenId: typeof position.tokenId === "string" ? position.tokenId : undefined,
    pair: typeof position.pair === "string" ? position.pair : undefined,
  };
}

function atomicUsdcToUsd(amountAtomic: string | undefined): string | undefined {
  if (!amountAtomic) return undefined;
  try {
    const atomic = BigInt(amountAtomic);
    const whole = atomic / 1_000_000n;
    const fractional = (atomic % 1_000_000n).toString().padStart(6, "0");
    return `${whole}.${fractional}`.replace(/\.?0+$/, "");
  } catch {
    return undefined;
  }
}

interface PaymentRequiredAccept {
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  extra?: { name?: string };
}

interface PaymentRequiredEnvelope {
  accepts?: PaymentRequiredAccept[];
}

function paymentSummaryFromResponse(
  res: Response,
): AuditPaymentSummary | undefined {
  const header = res.getHeader("PAYMENT-REQUIRED");
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== "string" || raw.length === 0) return undefined;

  try {
    const envelope = JSON.parse(
      Buffer.from(raw, "base64").toString("utf-8"),
    ) as PaymentRequiredEnvelope;
    const accept = envelope.accepts?.[0];
    if (!accept) return undefined;
    const amountAtomic = accept.amount ?? accept.maxAmountRequired;
    return {
      network: accept.network,
      asset: accept.extra?.name ?? "USDC",
      amountAtomic,
      amountUsd: atomicUsdcToUsd(amountAtomic),
      mode: "required",
    };
  } catch {
    return {
      mode: "required",
    };
  }
}

function reportSummary(report: RiskReport) {
  return {
    reportId: report.reportId,
    mode: report.mode,
    adapter: report.adapter,
    riskScore: report.risk.score,
    riskLevel: report.risk.level,
    recommendation: report.recommendation.action,
  };
}

// ---------------------------------------------------------------------------
// Express + x402 wiring
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "32kb" }));

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!REPORT_PATHS.has(req.path)) {
    next();
    return;
  }

  const requestId = requestIdFromHeader(req);
  const startedAt = Date.now();
  const body = req.body as RiskReportRequest;
  res.locals.auditRequestId = requestId;
  res.setHeader("X-Agentic-Request-Id", requestId);

  writeSellerAuditEvent({
    eventType: "seller.request_received",
    requestId,
    method: req.method,
    path: req.path,
    wallet: walletFromBody(body),
    position: positionFromBody(body),
  });

  res.on("finish", () => {
    const payment =
      res.statusCode === 402 ? paymentSummaryFromResponse(res) : undefined;
    if (payment) {
      writeSellerAuditEvent({
        eventType: "seller.payment_required",
        requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        payment,
      });
    }
    writeSellerAuditEvent({
      eventType: "seller.response_finished",
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      payment,
    });
  });

  next();
});

// Public health probe.
app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({ ok: true, service: "defi-guardian-paid-api" });
});

// Public mock endpoint, no payment required.
app.post("/mock/defi-risk-report", (req: Request, res: Response) => {
  const validation = validateRiskReportPayload(req.body as RiskReportRequest);
  if (!validation.ok) {
    res.status(400).json({
      error: "invalid_request",
      missing_fields: validation.missing,
    });
    return;
  }
  const report = defiGuardianAdapter.analyzePosition(
    req.body as RiskReportRequest,
  );
  writeSellerAuditEvent({
    eventType: "seller.report_generated",
    requestId: String(res.locals.auditRequestId),
    method: req.method,
    path: req.path,
    wallet: walletFromBody(req.body as RiskReportRequest),
    position: positionFromBody(req.body as RiskReportRequest),
    report: reportSummary(report),
  });
  res.status(200).json(report);
});

// x402-protected resource server. Only /paid/defi-risk-report is gated.
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme(),
);

app.use(
  paymentMiddleware(
    {
      "POST /paid/defi-risk-report": {
        accepts: [
          {
            scheme: "exact",
            price: REPORT_PRICE_USD,
            network: NETWORK,
            payTo: SELLER_RECEIVER_ADDRESS_TYPED,
          },
        ],
        description: "Mock DeFi Guardian risk report for a wallet/position.",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// Once the middleware accepts a payment, this handler runs.
app.post("/paid/defi-risk-report", (req: Request, res: Response) => {
  const validation = validateRiskReportPayload(req.body as RiskReportRequest);
  if (!validation.ok) {
    res.status(400).json({
      error: "invalid_request",
      missing_fields: validation.missing,
    });
    return;
  }
  const report = defiGuardianAdapter.analyzePosition(
    req.body as RiskReportRequest,
  );
  writeSellerAuditEvent({
    eventType: "seller.report_generated",
    requestId: String(res.locals.auditRequestId),
    method: req.method,
    path: req.path,
    wallet: walletFromBody(req.body as RiskReportRequest),
    position: positionFromBody(req.body as RiskReportRequest),
    payment: {
      network: NETWORK,
      asset: "USDC",
      amountAtomic: "1000",
      amountUsd: "0.001",
      mode: "accepted",
    },
    report: reportSummary(report),
  });
  res.status(200).json(report);
});

// JSON 500 handler so unexpected throws don't leak HTML.
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (REPORT_PATHS.has(req.path)) {
    writeSellerAuditEvent({
      eventType: "seller.error",
      requestId: String(res.locals.auditRequestId ?? randomUUID()),
      method: req.method,
      path: req.path,
      statusCode: 500,
      error: {
        message: err instanceof Error ? err.message : "unknown error",
      },
    });
  }
  console.error("[seller-api] unhandled error:", err);
  res.status(500).json({ error: "internal_error" });
});

app.listen(PORT, () => {
  console.log(
    `[seller-api] listening on http://localhost:${PORT} ` +
      `network=${NETWORK} facilitator=${FACILITATOR_URL} ` +
      `price=${REPORT_PRICE_USD} payTo=${SELLER_RECEIVER_ADDRESS}`,
  );
});
