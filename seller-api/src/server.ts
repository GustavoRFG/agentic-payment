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
 * Base Sepolia by default. Base mainnet is available only when
 * X402_USE_MAINNET=1 is explicitly set.
 */

import express, { type NextFunction, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import type { RouteConfig } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { loadEnvUnlessDisabled } from "./config/loadEnv";
import {
  MAINNET_NETWORK,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  PAYMENT_PRICE_LABEL,
  TEXT_ANALYSIS_API_KEY_ENV_NAME,
  activeFacilitatorUrl,
  activePaymentNetwork,
  isPaymentNetworkAllowed,
} from "./config/safety";
import { analyzeCode } from "./adapters/code-analysis/analyzer";
import { validateCodeAnalysisRequest } from "./adapters/code-analysis/validate";
import type { CodeAnalysisRequest } from "./adapters/code-analysis/types";
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
import { extractData } from "./adapters/extract-data/analyzer";
import { validateExtractDataRequest } from "./adapters/extract-data/validate";
import type { ExtractDataRequest } from "./adapters/extract-data/types";
import { summarizeText } from "./adapters/summarize/analyzer";
import { validateSummarizeRequest } from "./adapters/summarize/validate";
import type { SummarizeRequest } from "./adapters/summarize/types";
import { translateText } from "./adapters/translate/analyzer";
import { validateTranslateRequest } from "./adapters/translate/validate";
import type { TranslateRequest } from "./adapters/translate/types";
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
const NETWORK = activePaymentNetwork() as Caip2Network;
const FACILITATOR_URL = activeFacilitatorUrl();
const SELLER_RECEIVER_ADDRESS_TYPED =
  SELLER_RECEIVER_ADDRESS as `0x${string}`;

const PAYMENT_AMOUNT_ATOMIC_002 = "2000" as const;
const PAYMENT_AMOUNT_USD_002 = "0.002" as const;
const PAYMENT_PRICE_LABEL_002 = "$0.002" as const;

function assertConfig(): void {
  const problems: string[] = [];
  if (!SELLER_RECEIVER_ADDRESS || !SELLER_RECEIVER_ADDRESS.startsWith("0x")) {
    problems.push(
      "SELLER_RECEIVER_ADDRESS must be a 0x-prefixed Base address.",
    );
  }
  if (!REPORT_PRICE_USD.startsWith("$")) {
    problems.push(
      'REPORT_PRICE_USD must start with "$" (e.g. "$0.001"); @x402/express ' +
        "rejects non-dollar-prefixed prices.",
    );
  }
  if (!isPaymentNetworkAllowed(NETWORK)) {
    problems.push(
      `Payment network "${NETWORK}" is not allowed without explicit opt-in.`,
    );
  }
  const adapterMockEnabled =
    process.env.AGENTIC_ADAPTER_MOCK === "1" ||
    process.env.AGENTIC_TEXT_ANALYSIS_MOCK === "1";
  if (
    !process.env[TEXT_ANALYSIS_API_KEY_ENV_NAME] &&
    !adapterMockEnabled &&
    process.env.AGENTIC_SKIP_DOTENV !== "1"
  ) {
    problems.push(
      `${TEXT_ANALYSIS_API_KEY_ENV_NAME} is required for the Claude adapters.`,
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
  "/paid/analyze-code",
  "/paid/summarize",
  "/paid/extract-data",
  "/paid/translate",
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

function codeAnalysisRequestFromLocals(res: Response): CodeAnalysisRequest {
  return res.locals.codeAnalysisRequest as CodeAnalysisRequest;
}

function summarizeRequestFromLocals(res: Response): SummarizeRequest {
  return res.locals.summarizeRequest as SummarizeRequest;
}

function extractDataRequestFromLocals(res: Response): ExtractDataRequest {
  return res.locals.extractDataRequest as ExtractDataRequest;
}

function translateRequestFromLocals(res: Response): TranslateRequest {
  return res.locals.translateRequest as TranslateRequest;
}

function invalidRequest(res: Response, missing: string[]): void {
  res.status(400).json({
    error: "invalid_request",
    missing_fields: missing,
  });
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
      invalidRequest(res, validation.missing);
      return;
    }
    res.locals.textAnalysisRequest = validation.data;
    next();
  },
);

app.post(
  "/paid/analyze-code",
  (req: Request, res: Response, next: NextFunction) => {
    const validation = validateCodeAnalysisRequest(req.body);
    if (!validation.ok) {
      invalidRequest(res, validation.missing);
      return;
    }
    res.locals.codeAnalysisRequest = validation.data;
    next();
  },
);

app.post(
  "/paid/summarize",
  (req: Request, res: Response, next: NextFunction) => {
    const validation = validateSummarizeRequest(req.body);
    if (!validation.ok) {
      invalidRequest(res, validation.missing);
      return;
    }
    res.locals.summarizeRequest = validation.data;
    next();
  },
);

app.post(
  "/paid/extract-data",
  (req: Request, res: Response, next: NextFunction) => {
    const validation = validateExtractDataRequest(req.body);
    if (!validation.ok) {
      invalidRequest(res, validation.missing);
      return;
    }
    res.locals.extractDataRequest = validation.data;
    next();
  },
);

app.post(
  "/paid/translate",
  (req: Request, res: Response, next: NextFunction) => {
    const validation = validateTranslateRequest(req.body);
    if (!validation.ok) {
      invalidRequest(res, validation.missing);
      return;
    }
    res.locals.translateRequest = validation.data;
    next();
  },
);

// x402-protected resource server.
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  NETWORK,
  new ExactEvmScheme(),
);

interface PaidServiceRouteConfig {
  price: string;
  description: string;
  input: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputExample: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

function exactPaymentAccept(price: string): RouteConfig["accepts"] {
  return [
    {
      scheme: "exact",
      price,
      network: NETWORK,
      payTo: SELLER_RECEIVER_ADDRESS_TYPED,
    },
  ];
}

function bazaarDiscovery(config: PaidServiceRouteConfig): Record<string, unknown> {
  return {
    ...declareDiscoveryExtension({
      bodyType: "json",
      input: config.input,
      inputSchema: config.inputSchema,
      output: {
        example: config.outputExample,
        schema: config.outputSchema,
      },
    }),
    discoverable: true,
  };
}

function paidServiceRoute(config: PaidServiceRouteConfig): RouteConfig {
  return {
    accepts: exactPaymentAccept(config.price),
    description: config.description,
    mimeType: "application/json",
    extensions: bazaarDiscovery(config),
  };
}

const paymentRoutes: Record<string, RouteConfig> = {
  "POST /paid/defi-risk-report": {
    accepts: exactPaymentAccept(REPORT_PRICE_USD),
    description: "Mock DeFi Guardian risk report for a wallet/position.",
    mimeType: "application/json",
  },
  "POST /paid/analyze-text": paidServiceRoute({
    price: PAYMENT_PRICE_LABEL,
    description:
      "Analyze text with Claude Haiku: summary, sentiment, and entities.",
    input: {
      text: "Analyze this product update for summary, sentiment, and entities.",
      mode: "full",
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to analyze. Maximum 2000 characters.",
          minLength: 1,
          maxLength: 2000,
        },
        mode: {
          type: "string",
          description:
            "Analysis mode: summary, sentiment, entities, or full.",
          enum: ["summary", "sentiment", "entities", "full"],
          default: "full",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    outputExample: {
      summary: "Concise summary.",
      sentiment: {
        label: "neutral",
        confidence: "high",
        rationale: "Short rationale.",
      },
      entities: [],
    },
    outputSchema: {
      properties: {
        summary: { type: "string" },
        sentiment: { type: "object" },
        entities: { type: "array" },
      },
      additionalProperties: true,
    },
  }),
  "POST /paid/analyze-code": paidServiceRoute({
    price: PAYMENT_PRICE_LABEL_002,
    description:
      "Analyze code with Claude Haiku for bugs, improvements, and complexity.",
    input: {
      code: "function add(a, b) { return a + b }",
      language: "javascript",
    },
    inputSchema: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Source code to review. Maximum 5000 characters.",
          minLength: 1,
          maxLength: 5000,
        },
        language: {
          type: "string",
          description: "Optional programming language hint.",
          maxLength: 60,
        },
      },
      required: ["code"],
      additionalProperties: false,
    },
    outputExample: {
      issues: [],
      suggestions: ["Add input validation where external data enters."],
      complexity: "low",
    },
    outputSchema: {
      properties: {
        issues: { type: "array" },
        suggestions: { type: "array" },
        complexity: { type: "string", enum: ["low", "medium", "high"] },
      },
      required: ["issues", "suggestions", "complexity"],
      additionalProperties: true,
    },
  }),
  "POST /paid/summarize": paidServiceRoute({
    price: PAYMENT_PRICE_LABEL,
    description: "Summarize text with Claude Haiku into concise points.",
    input: {
      text: "Long text to summarize.",
      maxPoints: 5,
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to summarize. Maximum 10000 characters.",
          minLength: 1,
          maxLength: 10000,
        },
        maxPoints: {
          type: "integer",
          description: "Maximum number of summary points. Defaults to 5.",
          minimum: 1,
          maximum: 20,
          default: 5,
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    outputExample: {
      points: ["First key point.", "Second key point."],
      wordCount: 120,
    },
    outputSchema: {
      properties: {
        points: { type: "array", items: { type: "string" } },
        wordCount: { type: "number" },
      },
      required: ["points", "wordCount"],
      additionalProperties: true,
    },
  }),
  "POST /paid/extract-data": paidServiceRoute({
    price: PAYMENT_PRICE_LABEL_002,
    description:
      "Extract requested fields from text with Claude Haiku, returning null when absent.",
    input: {
      text: "Invoice ACME-42 total $19.99 due 2026-06-30.",
      fields: ["invoice_id", "total", "due_date"],
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to inspect. Maximum 5000 characters.",
          minLength: 1,
          maxLength: 5000,
        },
        fields: {
          type: "array",
          description: "Field names to extract from the text.",
          minItems: 1,
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 80 },
        },
      },
      required: ["text", "fields"],
      additionalProperties: false,
    },
    outputExample: {
      extracted: {
        invoice_id: "ACME-42",
        total: "$19.99",
        due_date: "2026-06-30",
      },
    },
    outputSchema: {
      properties: {
        extracted: {
          type: "object",
          additionalProperties: { type: ["string", "null"] },
        },
      },
      required: ["extracted"],
      additionalProperties: true,
    },
  }),
  "POST /paid/translate": paidServiceRoute({
    price: PAYMENT_PRICE_LABEL,
    description:
      "Translate text with Claude Haiku and detect the source language.",
    input: {
      text: "Hola mundo.",
      targetLanguage: "English",
    },
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "Text to translate. Maximum 5000 characters.",
          minLength: 1,
          maxLength: 5000,
        },
        targetLanguage: {
          type: "string",
          description: "Language to translate into, such as English or pt-BR.",
          minLength: 1,
          maxLength: 80,
        },
      },
      required: ["text", "targetLanguage"],
      additionalProperties: false,
    },
    outputExample: {
      translation: "Hello world.",
      detectedSourceLanguage: "Spanish",
    },
    outputSchema: {
      properties: {
        translation: { type: "string" },
        detectedSourceLanguage: { type: "string" },
      },
      required: ["translation", "detectedSourceLanguage"],
      additionalProperties: true,
    },
  }),
};

app.use(paymentMiddleware(paymentRoutes, resourceServer));

function writePaidAdapterAuditEvent(
  req: Request,
  res: Response,
  mode: string,
  amountAtomic: string,
  amountUsd: string,
): void {
  writeSellerAuditEvent({
    eventType: "seller.report_generated",
    requestId: String(res.locals.auditRequestId),
    method: req.method,
    path: req.path,
    payment: {
      network: NETWORK,
      asset: PAYMENT_ASSET,
      amountAtomic,
      amountUsd,
      mode: "accepted",
    },
    report: {
      reportId: String(res.locals.auditRequestId),
      mode,
      adapter: {
        requestedMode: mode,
        resolvedMode: mode,
        fallbackUsed: false,
      },
      riskScore: 0,
      riskLevel: "low",
      recommendation: "n/a",
    },
  });
}

app.post("/paid/analyze-text", async (req: Request, res: Response) => {
  const requestId = String(res.locals.auditRequestId);
  const result = await analyzeText(textAnalysisRequestFromLocals(res), requestId);
  writePaidAdapterAuditEvent(
    req,
    res,
    "adapter-text-analysis",
    PAYMENT_AMOUNT_ATOMIC,
    PAYMENT_AMOUNT_USD,
  );
  res.status(200).json(result);
});

app.post("/paid/analyze-code", async (req: Request, res: Response) => {
  const result = await analyzeCode(codeAnalysisRequestFromLocals(res));
  writePaidAdapterAuditEvent(
    req,
    res,
    "adapter-code-analysis",
    PAYMENT_AMOUNT_ATOMIC_002,
    PAYMENT_AMOUNT_USD_002,
  );
  res.status(200).json(result);
});

app.post("/paid/summarize", async (req: Request, res: Response) => {
  const result = await summarizeText(summarizeRequestFromLocals(res));
  writePaidAdapterAuditEvent(
    req,
    res,
    "adapter-summarize",
    PAYMENT_AMOUNT_ATOMIC,
    PAYMENT_AMOUNT_USD,
  );
  res.status(200).json(result);
});

app.post("/paid/extract-data", async (req: Request, res: Response) => {
  const result = await extractData(extractDataRequestFromLocals(res));
  writePaidAdapterAuditEvent(
    req,
    res,
    "adapter-extract-data",
    PAYMENT_AMOUNT_ATOMIC_002,
    PAYMENT_AMOUNT_USD_002,
  );
  res.status(200).json(result);
});

app.post("/paid/translate", async (req: Request, res: Response) => {
  const result = await translateText(translateRequestFromLocals(res));
  writePaidAdapterAuditEvent(
    req,
    res,
    "adapter-translate",
    PAYMENT_AMOUNT_ATOMIC,
    PAYMENT_AMOUNT_USD,
  );
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
      `network=${NETWORK} ` +
      `${NETWORK === MAINNET_NETWORK ? " MAINNET" : "testnet"} ` +
      `facilitator=${FACILITATOR_URL} ` +
      `price=${REPORT_PRICE_USD} payTo=${SELLER_RECEIVER_ADDRESS}`,
  );
});
