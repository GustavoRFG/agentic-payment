/**
 * rich-tx-explainer-live-bindings — wallet load + paid POST for allowlisted tx_explainer.
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
import { compareUsdcDecimal } from "./external-x402-get-policy";
import type { RichTxExplainerHandshake } from "./rich-tx-explainer-handshake";
import type { RichTxExplainerPolicy } from "./rich-tx-explainer-policy";

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
  readonly paymentResponseHeaderPresent: boolean;
  readonly paymentResponseHeaderSha256: string | null;
}

export interface RichWalletHandle {
  readonly walletFingerprint: string;
  readonly publicAddress?: string;
  readonly signer: unknown;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function loadRichBuyerWallet(
  env: Record<string, string | undefined>,
  importModule: (specifier: string) => Promise<unknown> = (specifier) => import(specifier),
): Promise<RichWalletHandle> {
  const privateKey = env.BUYER_PRIVATE_KEY?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("BUYER_PRIVATE_KEY is not configured for rich tx explainer paid probe");
  }
  const accounts = (await importModule(
    "../../buyer-client/node_modules/viem/_esm/accounts/index.js",
  )) as { readonly privateKeyToAccount: (key: `0x${string}`) => { address: string } };
  const account = accounts.privateKeyToAccount(privateKey as `0x${string}`);
  return {
    signer: account,
    publicAddress: account.address,
    walletFingerprint: sha256(account.address.toLowerCase()).slice(0, 16),
  };
}

export async function performRichTxExplainerPaidRequest(options: {
  readonly policy: RichTxExplainerPolicy;
  readonly handshake: RichTxExplainerHandshake;
  readonly txHash: string;
  readonly wallet: RichWalletHandle;
  readonly paidInvocationGuard: PaidInvocationGuard;
  readonly paymentBearingGuard: PaymentBearingRequestGuard;
  readonly fetchImpl?: typeof fetch;
  readonly importModule?: (specifier: string) => Promise<unknown>;
}): Promise<RichPaidResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const importModule = options.importModule ?? ((specifier) => import(specifier));

  if (compareUsdcDecimal(options.handshake.quoteUsdc, options.policy.maxTotalSpendUsdc) > 0) {
    throw new Error("handshake quote exceeds policy cap");
  }
  if (options.handshake.network !== MAINNET_NETWORK) {
    throw new Error("handshake network is not Base mainnet");
  }
  if (
    options.handshake.assetAddress &&
    options.handshake.assetAddress.toLowerCase() !== MAINNET_USDC_ADDRESS.toLowerCase()
  ) {
    throw new Error("handshake asset is not Base USDC");
  }

  let totalHttp = 0;
  const guardedFetch: typeof fetch = async (input, init) => {
    totalHttp += 1;
    const safeInit: RequestInit = { ...init, redirect: "manual" };
    options.paymentBearingGuard.inspectRequest(input, safeInit);
    return fetchImpl(input, safeInit);
  };

  const fetchModule = (await importModule(
    "../../buyer-client/node_modules/@x402/fetch/dist/esm/index.mjs",
  )) as {
    readonly x402Client: new () => unknown;
    readonly wrapFetchWithPayment: (fetchImpl: typeof fetch, client: unknown) => typeof fetch;
  };
  const evmModule = (await importModule(
    "../../buyer-client/node_modules/@x402/evm/dist/esm/exact/client/index.mjs",
  )) as {
    readonly registerExactEvmScheme: (
      client: unknown,
      options: { readonly signer: unknown; readonly networks: readonly string[] },
    ) => void;
  };

  const client = new fetchModule.x402Client();
  evmModule.registerExactEvmScheme(client, {
    signer: options.wallet.signer,
    networks: [options.policy.allowedNetwork],
  });
  const paymentFetch = fetchModule.wrapFetchWithPayment(guardedFetch, client);

  const requestBody = options.policy.buildRequestBody(
    options.txHash,
    options.policy.targetChainId,
  );
  const url = options.handshake.endpointUrl;

  options.paidInvocationGuard.assertNext();
  const response = await paymentFetch(url, {
    method: options.policy.method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: options.policy.method === "POST" ? JSON.stringify(requestBody) : undefined,
    redirect: "manual",
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`paid request redirect HTTP ${response.status}`);
  }
  if (response.status !== 200) {
    throw new Error(`paid request HTTP ${response.status}`);
  }

  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = { content_type: "text/plain", text: text.slice(0, 8192) };
  }

  const paymentHeader =
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  let paymentEvidence: unknown = { payment_response_header_present: Boolean(paymentHeader) };
  let settlementEvidence: unknown = null;
  let receipt: unknown = null;
  let transactionHash: string | null = null;

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
      if (decoded && typeof decoded === "object") {
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
    httpStatus: response.status,
    responseBody: body,
    responseBodySha256: sha256(text),
    contentType: response.headers.get("content-type") ?? "application/json",
    actualAmountUsdc: options.handshake.quoteUsdc,
    transactionHash,
    paymentEvidence,
    settlementEvidence,
    receipt,
    paymentInvocationCount: options.paidInvocationGuard.getAttempts(),
    paymentBearingRequestCount: options.paymentBearingGuard.getPaymentBearingRequests(),
    paymentResponseHeaderPresent: Boolean(paymentHeader),
    paymentResponseHeaderSha256: paymentHeader ? sha256(paymentHeader) : null,
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
