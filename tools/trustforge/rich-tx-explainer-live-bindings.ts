/**
 * rich-tx-explainer-live-bindings — wallet load + paid POST for allowlisted tx_explainer.
 *
 * Settlement signing/send core delegates to x402-single-settlement-executor.
 */

import { createHash } from "node:crypto";
import { MAINNET_NETWORK, MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  createPaidInvocationGuard,
  type PaidInvocationGuard,
} from "../../buyer-client/src/paid-invocation-guard";
import {
  createPaymentBearingRequestGuard,
  type PaymentBearingRequestGuard,
} from "../../buyer-client/src/payment-bearing-request-guard";
import { compareUsdcDecimal, parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import {
  buildPaid402Capture,
  PaidRequest402Error,
} from "./paid-402-response-sanitize";
import type { RichTxExplainerHandshake } from "./rich-tx-explainer-handshake";
import type { RichTxExplainerPolicy } from "./rich-tx-explainer-policy";
import {
  MAINNET_BUYER_PRIVATE_KEY_ENV,
  MAINNET_BUYER_WALLET,
} from "./network-config";
import { executeSingleX402Settlement } from "./x402-single-settlement-executor";
import { createThinSettlementRequestBinding } from "./thin-settlement-request-binding";
import { planThinSettleRequest } from "./thin-settlement-method-contract";

export interface RichPaidResponse {
  readonly httpStatus: number;
  readonly responseBody: unknown;
  readonly responseBodySha256: string;
  readonly contentType: string;
  readonly actualAmountUsdc: string;
  readonly transactionHash: string | null;
  readonly paymentEvidence: unknown;
  readonly settlementEvidence: unknown;
  readonly receipt: unknown;
  readonly paymentInvocationCount: number;
  readonly paymentBearingRequestCount: number;
  readonly paymentHeaderCreated: boolean;
  readonly paymentHeaderSent: boolean;
  readonly paymentResponseHeaderPresent: boolean;
  readonly paymentResponseHeaderSha256: string | null;
  readonly settlementIntentPath: string | null;
  readonly settlementAttemptId: string | null;
}

export interface RichWalletHandle {
  readonly walletFingerprint: string;
  readonly publicAddress?: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function loadRichBuyerWallet(
  env: Record<string, string | undefined>,
): Promise<RichWalletHandle> {
  const privateKey = env.BUYER_PRIVATE_KEY?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("BUYER_PRIVATE_KEY is not configured for rich tx explainer paid probe");
  }
  if (env.SEPOLIA_BUYER_PRIVATE_KEY?.trim()) {
    throw new Error(
      "BLOCKED_CROSS_NETWORK_KEY: SEPOLIA_BUYER_PRIVATE_KEY must be absent during mainnet paid probe",
    );
  }
  return {
    publicAddress: MAINNET_BUYER_WALLET,
    walletFingerprint: sha256(MAINNET_BUYER_WALLET.toLowerCase()).slice(0, 16),
  };
}

export async function performRichTxExplainerPaidRequest(options: {
  readonly policy: RichTxExplainerPolicy;
  readonly handshake: RichTxExplainerHandshake;
  readonly authorizedMethod: "GET" | "POST";
  readonly txHash: string;
  readonly wallet: RichWalletHandle;
  readonly paidInvocationGuard: PaidInvocationGuard;
  readonly paymentBearingGuard: PaymentBearingRequestGuard;
  readonly attemptId?: string | null;
  readonly runDir?: string;
  readonly authorizationHash?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly importModule?: (specifier: string) => Promise<unknown>;
  readonly now?: () => Date;
}): Promise<RichPaidResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const env = options.env ?? process.env;

  if (compareUsdcDecimal(options.handshake.quoteUsdc, options.policy.maxTotalSpendUsdc) > 0) {
    throw new Error("handshake quote exceeds policy cap");
  }
  if (options.handshake.network !== MAINNET_NETWORK) {
    throw new Error("handshake network is not Base mainnet");
  }
  const asset = options.handshake.assetAddress ?? MAINNET_USDC_ADDRESS;
  if (asset.toLowerCase() !== MAINNET_USDC_ADDRESS.toLowerCase()) {
    throw new Error("handshake asset is not Base USDC");
  }

  const requestBody = options.policy.buildRequestBody(
    options.txHash,
    options.policy.targetChainId,
  );
  const requestBinding = createThinSettlementRequestBinding({
    endpoint: options.handshake.endpointUrl,
    method: options.policy.method,
    input_status: "known",
    query: [],
    body: requestBody,
  });
  const requestPlan = planThinSettleRequest({ requestBinding });
  if (!requestPlan.supported) throw new Error(requestPlan.reason);
  const maxAmountAtomic = parseUsdcDecimalToAtomic(options.policy.maxTotalSpendUsdc).toString();

  const settlement = await executeSingleX402Settlement({
    request: {
      network: options.handshake.network,
      privateKeyEnvName: MAINNET_BUYER_PRIVATE_KEY_ENV,
      expectedBuyerAddress: MAINNET_BUYER_WALLET,
      endpoint: requestPlan.endpoint,
      method: requestPlan.method,
      authorizedMethod: options.authorizedMethod,
      authorizedRequestBindingSha256: requestBinding.binding_sha256,
      plannedRequestBinding: requestBinding,
      body: requestPlan.body,
      asset,
      payTo: options.handshake.payTo,
      quotedAmountAtomic: options.handshake.amountAtomic,
      maxAmountAtomic,
      runDir: options.runDir ?? process.cwd(),
      authorizationHash: options.authorizationHash ?? "",
      attemptId: options.attemptId ?? undefined,
      runId: options.attemptId ?? undefined,
      registerNetworks: [options.policy.allowedNetwork],
      require402BeforePayment: false,
    },
    env,
    fetchImpl,
    paidInvocationGuard: options.paidInvocationGuard,
    paymentBearingGuard: options.paymentBearingGuard,
  });

  const paymentBearingRequestCount = settlement.paymentBearingHttpRequestCount;
  const paymentHeaderSent = paymentBearingRequestCount > 0;
  const paymentHeaderCreated = paymentHeaderSent;
  const text = settlement.responseBody;

  if (settlement.httpStatus !== null && settlement.httpStatus >= 300 && settlement.httpStatus < 400) {
    throw new Error(`paid request redirect HTTP ${settlement.httpStatus}`);
  }

  if (settlement.httpStatus === 402) {
    const replayResponse = new Response(text, {
      status: settlement.httpStatus,
      headers: settlement.responseHeaders,
    });
    const capture = buildPaid402Capture({
      response: replayResponse,
      responseBodyText: text,
      attemptId: options.attemptId ?? null,
      provider: options.policy.provider,
      serviceId: options.policy.serviceId,
      endpoint: options.handshake.endpointUrl,
      unpaidScheme: "exact",
      unpaidNetwork: options.handshake.network,
      unpaidAmountAtomic: options.handshake.amountAtomic,
      now: options.now,
    });
    throw new PaidRequest402Error(`paid request HTTP 402`, {
      capture,
      paymentBearingHttpRequestCount: paymentBearingRequestCount,
      paymentHeaderCreated,
      paymentHeaderSent,
    });
  }

  if (settlement.httpStatus !== 200) {
    throw new Error(`paid request HTTP ${settlement.httpStatus}`);
  }

  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = { content_type: "text/plain", text: text.slice(0, 8192) };
  }

  const paymentHeader =
    settlement.responseHeaders.get("payment-response") ??
    settlement.responseHeaders.get("x-payment-response");
  let paymentEvidence: unknown = { payment_response_header_present: Boolean(paymentHeader) };
  let settlementEvidence: unknown = null;
  let receipt: unknown = null;
  let transactionHash: string | null = settlement.facilitatorTransactionHash;

  if (paymentHeader) {
    try {
      const httpModule = (await importModule(
        "../../buyer-client/node_modules/@x402/core/dist/esm/http/index.mjs",
      )) as {
        readonly decodePaymentResponseHeader?: (value: string) => unknown;
      };
      const decoded = httpModule.decodePaymentResponseHeader?.(paymentHeader) ?? null;
      paymentEvidence = { decoded, payment_response_header_present: true };
      settlementEvidence = decoded;
      receipt = decoded;
      if (!transactionHash && decoded && typeof decoded === "object") {
        const record = decoded as Record<string, unknown>;
        const tx =
          record.transactionHash ??
          record.transaction_hash ??
          (record.transaction as Record<string, unknown> | undefined)?.hash;
        if (typeof tx === "string") transactionHash = tx;
      }
    } catch (error) {
      paymentEvidence = {
        payment_response_header_present: true,
        decode_error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    httpStatus: settlement.httpStatus ?? 0,
    responseBody: body,
    responseBodySha256: sha256(text),
    contentType: settlement.responseHeaders.get("content-type") ?? "application/json",
    actualAmountUsdc: options.handshake.quoteUsdc,
    transactionHash,
    paymentEvidence,
    settlementEvidence,
    receipt,
    paymentInvocationCount: options.paidInvocationGuard.getAttempts(),
    paymentBearingRequestCount,
    paymentHeaderCreated,
    paymentHeaderSent,
    paymentResponseHeaderPresent: Boolean(paymentHeader),
    paymentResponseHeaderSha256: paymentHeader ? sha256(paymentHeader) : null,
    settlementIntentPath: settlement.intentPath,
    settlementAttemptId: settlement.attemptId,
  };
}

export function createRichPaidGuards(): {
  readonly paidInvocationGuard: PaidInvocationGuard;
  readonly paymentBearingGuard: PaymentBearingRequestGuard;
} {
  return {
    paidInvocationGuard: createPaidInvocationGuard({ maxAttempts: 1 }),
    paymentBearingGuard: createPaymentBearingRequestGuard({ maxPaymentBearingRequests: 1 }),
  };
}
