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
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  defiGuardianAdapter,
  validateRiskReportPayload,
} from "./domain/defiGuardianAdapter";
import type { RiskReportRequest } from "./domain/reportTypes";

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
// Express + x402 wiring
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "32kb" }));

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
  res
    .status(200)
    .json(defiGuardianAdapter.analyzePosition(req.body as RiskReportRequest));
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
  res
    .status(200)
    .json(defiGuardianAdapter.analyzePosition(req.body as RiskReportRequest));
});

// JSON 500 handler so unexpected throws don't leak HTML.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
