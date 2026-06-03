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
import { randomUUID } from "node:crypto";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { loadEnvUnlessDisabled } from "./config/loadEnv";
import {
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  PAYMENT_PRICE_LABEL,
  TESTNET_NETWORK,
  TEXT_ANALYSIS_API_KEY_ENV_NAME,
} from "./config/safety";
import {
  defiGuardianAdapter,
  validateRiskReportPayload,
} from "./adapters/defi-guardian/defiGuardianAdapter";
import type {
  RiskReport,
  RiskReportRequest,
} from "./adapters/defi-guardian/reportTypes";
import { analyzeText } from "./adapters/text-analysis/analyzer";
import { validateTextAnalysisRequest } from "./adapters/text-analysis/validate";
import type { TextAnalysisRequest } from "./adapters/text-analysis/types";
import { writeSellerAuditEvent } from "./observability/auditLogger";
import type {
  AuditPaymentSummary,
  AuditPositionSummary,
} from "./observability/auditTypes";

loadEnvUnlessDisabled();

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type Caip2Network = `${string}:${string}`;

const PORT = Number.parseInt(process.env.PORT ?? "4021", 10);
const SELLER_RECEIVER_ADDRESS = process.env.SELLER_RECEIVER_ADDRESS ?? "";
const REPORT_PRICE_USD = process.env.REPORT_PRICE_USD ?? PAYMENT_PRICE_LABEL;
const FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const NETWORK = (process.env.X402_NETWORK ?? TESTNET_NETWORK) as Caip2Network;
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
  if (NETWORK !== TESTNET_NETWORK) {
    problems.push(
      `X402_NETWORK is "${NETWORK}"; MVP 001 is testnet only (${TESTNET_NETWORK}).`,
    );
  }
  if (
    !process.env[TEXT_ANALYSIS_API_KEY_ENV_NAME] &&
    process.env.AGENTIC_SKIP_DOTENV !== "1"
  ) {
    problems.push(
      `${TEXT_ANALYSIS_API_KEY_ENV_NAME} is required for the text-analysis adapter.`,
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
  "/paid/analyze-text",
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
      asset: accept.extra?.name ?? PAYMENT_ASSET,
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

function textAnalysisRequestFromLocals(res: Response): TextAnalysisRequest {
  return res.locals.textAnalysisRequest as TextAnalysisRequest;
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

app.post(
  "/paid/analyze-text",
  (req: Request, res: Response, next: NextFunction) => {
    const validation = validateTextAnalysisRequest(req.body);
    if (!validation.ok) {
      res.status(400).json({
        error: "invalid_request",
        missing_fields: validation.missing,
      });
      return;
    }
    res.locals.textAnalysisRequest = validation.data;
    next();
  },
);

// x402-protected resource server.
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
      "POST /paid/analyze-text": {
        accepts: [
          {
            scheme: "exact",
            price: REPORT_PRICE_USD,
            network: NETWORK,
            payTo: SELLER_RECEIVER_ADDRESS_TYPED,
          },
        ],
        description: "Analyze text with Claude: summary, sentiment, and entities.",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.post("/paid/analyze-text", async (req: Request, res: Response) => {
  const requestId = String(res.locals.auditRequestId);
  const result = await analyzeText(textAnalysisRequestFromLocals(res), requestId);
  writeSellerAuditEvent({
    eventType: "seller.report_generated",
    requestId,
    method: req.method,
    path: req.path,
    payment: {
      network: NETWORK,
      asset: PAYMENT_ASSET,
      amountAtomic: PAYMENT_AMOUNT_ATOMIC,
      amountUsd: PAYMENT_AMOUNT_USD,
      mode: "accepted",
    },
    report: {
      reportId: requestId,
      mode: "adapter-text-analysis",
      adapter: {
        requestedMode: "adapter-text-analysis",
        resolvedMode: "adapter-text-analysis",
        fallbackUsed: false,
      },
      riskScore: 0,
      riskLevel: "low",
      recommendation: "n/a",
    },
  });
  res.status(200).json(result);
});

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
      asset: PAYMENT_ASSET,
      amountAtomic: PAYMENT_AMOUNT_ATOMIC,
      amountUsd: PAYMENT_AMOUNT_USD,
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
