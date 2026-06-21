/**
 * sepolia-seller-handshake — capture local seller-api 402 for target_selection synthesis.
 */

import {
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  TESTNET_NETWORK,
  TESTNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import { classifyTargetProbeResponse, type TargetHandshakeOutcome } from "./target-liveness";
import type { TargetCandidate } from "./target-candidates";

export const SEPOLIA_LOCAL_PROVIDER = "TrustForgeLocalSeller" as const;
export const SEPOLIA_LOCAL_SERVICE_ID = "local_analyze_text" as const;
export const SEPOLIA_LOCAL_ROUTE = "/paid/analyze-text" as const;

export interface SepoliaSellerHandshakeAccept {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amountAtomic: string;
  readonly payTo: string;
}

export interface SepoliaSellerHandshakeResult {
  readonly sellerBaseUrl: string;
  readonly endpoint: string;
  readonly statusCode: number;
  readonly outcome: TargetHandshakeOutcome;
  readonly accept: SepoliaSellerHandshakeAccept | null;
}

export interface SepoliaTargetSelectionDocument {
  readonly schema_name: "trustforge_target_selection";
  readonly schema_version: "1.0.0";
  readonly network: typeof TESTNET_NETWORK;
  readonly asset: typeof TESTNET_USDC_ADDRESS;
  readonly selection: {
    readonly primary: {
      readonly handshakeStatus: string;
      readonly resourceUrl: string;
      readonly quoteUsdc: string;
      readonly quoteAtomic: string;
      readonly selectedPayTo: string;
      readonly network: typeof TESTNET_NETWORK;
      readonly asset: typeof TESTNET_USDC_ADDRESS;
      readonly scoringRationale: readonly string[];
    };
    readonly fallbacks: readonly [];
  };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function buildSepoliaLocalSellerCandidate(
  sellerBaseUrl: string,
  quoteAtomic: string = PAYMENT_AMOUNT_ATOMIC,
  payTo: string,
): TargetCandidate {
  const base = normalizeBaseUrl(sellerBaseUrl);
  return {
    candidateId: SEPOLIA_LOCAL_SERVICE_ID,
    resourceUrl: `${base}${SEPOLIA_LOCAL_ROUTE}`,
    method: "POST",
    x402Version: 2,
    freshness: { lastUpdated: new Date().toISOString(), sortKey: new Date().toISOString() },
    registrationMetadata: {},
    accepts: [
      {
        scheme: "exact",
        network: TESTNET_NETWORK,
        asset: TESTNET_USDC_ADDRESS,
        amountAtomic: quoteAtomic,
        payTo,
        maxTimeoutSeconds: 300,
      },
    ],
  };
}

export function parseSepoliaSeller402Response(input: {
  readonly sellerBaseUrl: string;
  readonly statusCode: number;
  readonly paymentRequiredHeader: string | null;
  readonly wwwAuthenticate?: string | null;
  readonly maxTargetPriceAtomic?: string;
}): SepoliaSellerHandshakeResult {
  const base = normalizeBaseUrl(input.sellerBaseUrl);
  const endpoint = `${base}${SEPOLIA_LOCAL_ROUTE}`;
  const candidate = buildSepoliaLocalSellerCandidate(
    base,
    PAYMENT_AMOUNT_ATOMIC,
    "0x0000000000000000000000000000000000000000",
  );
  const headers: Record<string, string> = {};
  if (input.paymentRequiredHeader) {
    headers["payment-required"] = input.paymentRequiredHeader;
  }
  headers["www-authenticate"] =
    input.wwwAuthenticate ??
    'Bearer nonce="sepolia-handshake-nonce", expires="2099-01-01T00:00:00.000Z"';
  const outcome = classifyTargetProbeResponse(
    candidate,
    {
      httpStatus: input.statusCode,
      headers,
      body: "",
    },
    {
      maxTargetPriceAtomic: input.maxTargetPriceAtomic ?? PAYMENT_AMOUNT_ATOMIC,
      expectedNetwork: TESTNET_NETWORK,
    },
  );
  const selected = outcome.selectedAccept;
  const accept =
    selected && selected.payTo
      ? {
          scheme: selected.scheme,
          network: selected.network,
          asset: selected.asset,
          amountAtomic: selected.amountAtomic,
          payTo: selected.payTo,
        }
      : null;
  return {
    sellerBaseUrl: base,
    endpoint,
    statusCode: input.statusCode,
    outcome,
    accept,
  };
}

export function buildSepoliaTargetSelectionFromHandshake(
  handshake: SepoliaSellerHandshakeResult,
): SepoliaTargetSelectionDocument {
  if (handshake.outcome.status !== "live_402_ok" || !handshake.accept) {
    throw new Error(
      `BLOCKED_SELLER_HANDSHAKE: expected live_402_ok, got ${handshake.outcome.status}`,
    );
  }
  if (handshake.accept.network !== TESTNET_NETWORK) {
    throw new Error(`BLOCKED_MAINNET_SIGNAL: seller network ${handshake.accept.network}`);
  }
  if (handshake.accept.asset.toLowerCase() !== TESTNET_USDC_ADDRESS.toLowerCase()) {
    throw new Error(`BLOCKED_WRONG_ASSET: seller asset ${handshake.accept.asset}`);
  }
  return {
    schema_name: "trustforge_target_selection",
    schema_version: "1.0.0",
    network: TESTNET_NETWORK,
    asset: TESTNET_USDC_ADDRESS,
    selection: {
      primary: {
        handshakeStatus: handshake.outcome.status,
        resourceUrl: handshake.endpoint,
        quoteUsdc: PAYMENT_AMOUNT_USD,
        quoteAtomic: handshake.accept.amountAtomic,
        selectedPayTo: handshake.accept.payTo,
        network: TESTNET_NETWORK,
        asset: TESTNET_USDC_ADDRESS,
        scoringRationale: [
          "local seller-api Base Sepolia handshake",
          "live_402_ok on eip155:84532",
          "Sepolia USDC exact scheme",
        ],
      },
      fallbacks: [],
    },
  };
}

export async function probeSepoliaLocalSeller(input: {
  readonly sellerBaseUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly requestBody?: unknown;
}): Promise<SepoliaSellerHandshakeResult> {
  const base = normalizeBaseUrl(input.sellerBaseUrl);
  const endpoint = `${base}${SEPOLIA_LOCAL_ROUTE}`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      input.requestBody ?? {
        text: "TrustForge Sepolia settlement proof handshake.",
        mode: "full",
      },
    ),
  });
  const header =
    response.headers.get("payment-required") ??
    response.headers.get("PAYMENT-REQUIRED");
  return parseSepoliaSeller402Response({
    sellerBaseUrl: base,
    statusCode: response.status,
    paymentRequiredHeader: header,
    wwwAuthenticate: response.headers.get("www-authenticate"),
  });
}
