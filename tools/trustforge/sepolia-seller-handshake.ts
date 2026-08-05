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
import {
  createThinSettlementRequestBinding,
  type ThinSettlementRequestBinding,
} from "./thin-settlement-request-binding";
import { planThinSettleRequest } from "./thin-settlement-method-contract";
import type { SellerRequirementsObservation } from "./x402-seller-requirements-binding";

export const SEPOLIA_LOCAL_PROVIDER = "TrustForgeLocalSeller" as const;
export const SEPOLIA_LOCAL_SERVICE_ID = "local_analyze_text" as const;
export const SEPOLIA_LOCAL_ROUTE = "/paid/analyze-text" as const;
export const SEPOLIA_LOCAL_REQUEST_BODY = {
  text: "TrustForge Sepolia settlement proof handshake.",
  mode: "full",
} as const;

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
  readonly requestBinding: ThinSettlementRequestBinding;
}

export interface SepoliaTargetSelectionDocument {
  readonly schema_name: "trustforge_target_selection";
  readonly schema_version: "2.0.0";
  readonly network: typeof TESTNET_NETWORK;
  readonly asset: typeof TESTNET_USDC_ADDRESS;
  readonly selection: {
    readonly primary: {
      readonly handshakeStatus: string;
      readonly resourceUrl: string;
      readonly method: "POST";
      readonly requestEndpoint: string;
      readonly requestInputStatus: "known";
      readonly requestQuery: ThinSettlementRequestBinding["query"];
      readonly requestBody: ThinSettlementRequestBinding["body"];
      readonly requestInputProvenance: "policy_generated_request_binding";
      readonly requestBindingSha256: string;
      readonly sellerRequirements: SellerRequirementsObservation;
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
  requestBody: unknown = SEPOLIA_LOCAL_REQUEST_BODY,
): TargetCandidate {
  const base = normalizeBaseUrl(sellerBaseUrl);
  const endpoint = `${base}${SEPOLIA_LOCAL_ROUTE}`;
  const requestBinding = createThinSettlementRequestBinding({
    endpoint,
    method: "POST",
    input_status: "known",
    query: [],
    body: requestBody,
  });
  return {
    candidateId: SEPOLIA_LOCAL_SERVICE_ID,
    resourceUrl: endpoint,
    method: "POST",
    x402Version: 2,
    freshness: { lastUpdated: new Date().toISOString(), sortKey: new Date().toISOString() },
    registrationMetadata: {},
    requestBinding,
    requestInputProvenance: "policy_generated_request_binding",
    requestBindingError: null,
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
  readonly requestBinding?: ThinSettlementRequestBinding;
}): SepoliaSellerHandshakeResult {
  const base = normalizeBaseUrl(input.sellerBaseUrl);
  const endpoint = `${base}${SEPOLIA_LOCAL_ROUTE}`;
  const candidate = buildSepoliaLocalSellerCandidate(
    base,
    PAYMENT_AMOUNT_ATOMIC,
    "0x0000000000000000000000000000000000000000",
    input.requestBinding?.body ?? SEPOLIA_LOCAL_REQUEST_BODY,
  );
  const requestBinding = input.requestBinding ?? candidate.requestBinding!;
  const headers: Record<string, string> = {};
  if (input.paymentRequiredHeader) {
    headers["payment-required"] = input.paymentRequiredHeader;
  }
  if (input.wwwAuthenticate) headers["www-authenticate"] = input.wwwAuthenticate;
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
    requestBinding,
  };
}

export function buildSepoliaTargetSelectionFromHandshake(
  handshake: SepoliaSellerHandshakeResult,
): SepoliaTargetSelectionDocument {
  if (
    handshake.outcome.status !== "live_402_ok" ||
    !handshake.accept ||
    !handshake.outcome.sellerRequirements
  ) {
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
    schema_version: "2.0.0",
    network: TESTNET_NETWORK,
    asset: TESTNET_USDC_ADDRESS,
    selection: {
      primary: {
        handshakeStatus: handshake.outcome.status,
        resourceUrl: handshake.endpoint,
        method: "POST",
        requestEndpoint: handshake.requestBinding.endpoint,
        requestInputStatus: handshake.requestBinding.input_status,
        requestQuery: handshake.requestBinding.query,
        requestBody: handshake.requestBinding.body,
        requestInputProvenance: "policy_generated_request_binding",
        requestBindingSha256: handshake.requestBinding.binding_sha256,
        sellerRequirements: handshake.outcome.sellerRequirements,
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
  const requestBody = input.requestBody ?? SEPOLIA_LOCAL_REQUEST_BODY;
  const requestBinding = createThinSettlementRequestBinding({
    endpoint,
    method: "POST",
    input_status: "known",
    query: [],
    body: requestBody,
  });
  const plan = planThinSettleRequest({ requestBinding });
  if (!plan.supported) throw new Error(plan.reason);
  const response = await fetchImpl(plan.endpoint, {
    method: plan.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan.body),
  });
  const header =
    response.headers.get("payment-required") ??
    response.headers.get("PAYMENT-REQUIRED");
  return parseSepoliaSeller402Response({
    sellerBaseUrl: base,
    statusCode: response.status,
    paymentRequiredHeader: header,
    wwwAuthenticate: response.headers.get("www-authenticate"),
    requestBinding,
  });
}
