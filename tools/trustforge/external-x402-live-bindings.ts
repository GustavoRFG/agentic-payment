import { createHash } from "node:crypto";
import {
  MAINNET_USDC_ADDRESS,
  MAINNET_NETWORK,
} from "../../shared/payment-safety";
import {
  inspectExternalX402GetHandshake,
  type ExternalHandshakeInspection,
} from "./external-x402-get-adapter";
import {
  type ExternalX402GetProbePolicy,
} from "./external-x402-get-policy";
import {
  liveReadinessDependencies as readinessOnlyDependencies,
  normalizeChainId,
  validateInspectionForPaidPolicy,
  type ExternalPaidProbeDependencies,
  type ExternalPaidRequestContext,
  type GroundTruthResult,
  type PaidResponse,
  type WalletHandle,
} from "./external-x402-paid-executor";

const DEFAULT_ETHEREUM_RPC_SOURCES = [
  "https://ethereum-rpc.publicnode.com",
  "https://cloudflare-eth.com",
] as const;

interface AccountLike {
  readonly address: string;
}

interface X402FetchModule {
  readonly x402Client: new () => unknown;
  readonly wrapFetchWithPayment: (
    fetchImpl: typeof fetch,
    client: unknown,
  ) => typeof fetch;
}

interface X402EvmModule {
  readonly registerExactEvmScheme: (
    client: unknown,
    options: {
      readonly signer: unknown;
      readonly networks: readonly string[];
    },
  ) => void;
}

interface X402CoreHttpModule {
  readonly decodePaymentResponseHeader?: (value: string) => unknown;
}

export interface CreatePaymentFetchOptions {
  readonly policy: ExternalX402GetProbePolicy;
  readonly wallet: WalletHandle;
  readonly guardedFetch: typeof fetch;
}

export interface LivePaidDependenciesOptions {
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly rpcSources?: readonly string[];
  readonly createPaymentFetch?: (
    options: CreatePaymentFetchOptions,
  ) => Promise<typeof fetch> | typeof fetch;
  readonly importModule?: (specifier: string) => Promise<unknown>;
  readonly now?: () => Date;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function liveReadinessDependencies(): ExternalPaidProbeDependencies {
  return readinessOnlyDependencies();
}

export function livePaidDependencies(
  options: LivePaidDependenciesOptions = {},
): ExternalPaidProbeDependencies {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    inspectHandshake: (policy) => inspectExternalX402GetHandshake(policy),
    verifyGroundTruthBefore: () =>
      verifyEthereumMainnetChainId({
        fetchImpl,
        sources: options.rpcSources,
      }),
    verifyGroundTruthAfter: () =>
      verifyEthereumMainnetChainId({
        fetchImpl,
        sources: options.rpcSources,
      }),
    loadWallet: (policy, inspection) =>
      loadExternalBuyerWalletFromEnv({
        policy,
        inspection,
        env,
        importModule: options.importModule,
      }),
    performPaidRequest: (policy, wallet, inspection, context) =>
      performExternalX402PaidGetRequest({
        policy,
        wallet,
        inspection,
        context,
        fetchImpl,
        createPaymentFetch: options.createPaymentFetch,
        importModule: options.importModule,
      }),
    now: options.now,
  };
}

export async function loadExternalBuyerWalletFromEnv(options: {
  readonly policy: ExternalX402GetProbePolicy;
  readonly inspection: ExternalHandshakeInspection;
  readonly env?: Record<string, string | undefined>;
  readonly importModule?: (specifier: string) => Promise<unknown>;
}): Promise<WalletHandle> {
  validateInspectionForPaidPolicy(options.policy, options.inspection);
  if (options.policy.allowedNetwork !== MAINNET_NETWORK) {
    throw new Error("external paid wallet loader is restricted to Base mainnet");
  }
  if (
    options.inspection.assetAddress &&
    options.inspection.assetAddress.toLowerCase() !== MAINNET_USDC_ADDRESS.toLowerCase()
  ) {
    throw new Error("external paid wallet loader requires mainnet USDC");
  }

  const privateKey = options.env?.BUYER_PRIVATE_KEY?.trim() ?? "";
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("BUYER_PRIVATE_KEY is not configured for external paid smoke");
  }

  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const accounts = (await importModule(
    "../../buyer-client/node_modules/viem/_esm/accounts/index.js",
  )) as {
    readonly privateKeyToAccount: (key: `0x${string}`) => AccountLike;
  };
  const account = accounts.privateKeyToAccount(privateKey as `0x${string}`);
  const normalizedAddress = account.address.toLowerCase();

  return {
    signer: account,
    publicAddress: account.address,
    walletFingerprint: sha256(normalizedAddress).slice(0, 16),
  };
}

export async function verifyEthereumMainnetChainId(options: {
  readonly fetchImpl?: typeof fetch;
  readonly sources?: readonly string[];
} = {}): Promise<GroundTruthResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sources = options.sources?.length
    ? options.sources
    : DEFAULT_ETHEREUM_RPC_SOURCES;
  const observed: string[] = [];

  try {
    for (const source of sources) {
      const response = await fetchImpl(source, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "eth_chainId",
          params: [],
          id: 1,
        }),
      });
      if (!response.ok) {
        throw new Error(`${source} returned HTTP ${response.status}`);
      }
      const body = (await response.json()) as { result?: unknown };
      if (body.result !== "0x1") {
        throw new Error(`${source} returned chainId=${String(body.result)}`);
      }
      observed.push(body.result);
    }

    return {
      ok: observed.length === sources.length && observed.every((value) => value === "0x1"),
      chainIdHex: "0x1",
      chainIdDecimal: 1,
      sources,
    };
  } catch (error) {
    return {
      ok: false,
      sources,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function performExternalX402PaidGetRequest(options: {
  readonly policy: ExternalX402GetProbePolicy;
  readonly wallet: WalletHandle;
  readonly inspection: ExternalHandshakeInspection;
  readonly context: ExternalPaidRequestContext;
  readonly fetchImpl?: typeof fetch;
  readonly createPaymentFetch?: (
    options: CreatePaymentFetchOptions,
  ) => Promise<typeof fetch> | typeof fetch;
  readonly importModule?: (specifier: string) => Promise<unknown>;
}): Promise<PaidResponse> {
  validateInspectionForPaidPolicy(options.policy, options.inspection);
  if (!options.wallet.signer) {
    throw new Error("external paid request requires loaded wallet signer");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let totalHttpRequestCount = 0;
  const guardedFetch: typeof fetch = async (input, init) => {
    totalHttpRequestCount += 1;
    const safeInit: RequestInit = {
      ...init,
      redirect: "manual",
    };
    const safeInput =
      input instanceof Request
        ? new Request(input, { redirect: "manual" })
        : input;
    options.context.paymentBearingGuard.inspectRequest(safeInput, safeInit);
    const response = await fetchImpl(safeInput, safeInit);
    return response;
  };

  const paymentFetch = options.createPaymentFetch
    ? await options.createPaymentFetch({
        policy: options.policy,
        wallet: options.wallet,
        guardedFetch,
      })
    : await defaultCreatePaymentFetch({
        policy: options.policy,
        wallet: options.wallet,
        guardedFetch,
        importModule: options.importModule,
      });

  const response = await paymentFetch(options.policy.exactUrl, {
    method: "GET",
    redirect: "manual",
    headers: {
      accept: "application/json",
    },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`external paid request received redirect HTTP ${response.status}`);
  }

  const text = await response.text();
  const responseBodySha256 = sha256(text);
  const parsed = parseResponseBody(text);
  const paymentResponseEvidence = await paymentResponseFromHeaders(
    response.headers,
    options.importModule,
  );
  const observedChainId = extractObservedChainId(parsed.value);

  return {
    httpStatus: response.status,
    responseHeadersSanitized: headersToSanitizedRecord(response.headers),
    responseBodySanitized: parsed.value,
    responseBodySha256,
    responseBodyParseable: parsed.parseable,
    observedChainId,
    actualAmountUsdc: options.inspection.quoteUsdc,
    network: options.inspection.network,
    asset: options.inspection.asset,
    transactionHash: paymentResponseEvidence.transactionHash,
    receipt: paymentResponseEvidence.receipt,
    settlementEvidence: paymentResponseEvidence.settlementEvidence,
    paymentEvidence: paymentResponseEvidence.paymentEvidence,
    paymentInvocationCount: options.context.paidInvocationGuard.getAttempts(),
    paymentBearingRequestCount:
      options.context.paymentBearingGuard.getPaymentBearingRequests(),
    totalHttpRequestCount,
  };
}

async function defaultCreatePaymentFetch(options: {
  readonly policy: ExternalX402GetProbePolicy;
  readonly wallet: WalletHandle;
  readonly guardedFetch: typeof fetch;
  readonly importModule?: (specifier: string) => Promise<unknown>;
}): Promise<typeof fetch> {
  const importModule = options.importModule ?? ((specifier) => import(specifier));
  const fetchModule = (await importModule(
    "../../buyer-client/node_modules/@x402/fetch/dist/esm/index.mjs",
  )) as X402FetchModule;
  const evmModule = (await importModule(
    "../../buyer-client/node_modules/@x402/evm/dist/esm/exact/client/index.mjs",
  )) as X402EvmModule;
  const client = new fetchModule.x402Client();
  evmModule.registerExactEvmScheme(client, {
    signer: options.wallet.signer,
    networks: [options.policy.allowedNetwork],
  });
  return fetchModule.wrapFetchWithPayment(options.guardedFetch, client);
}

function parseResponseBody(text: string): { value: unknown; parseable: boolean } {
  try {
    return { value: JSON.parse(text), parseable: true };
  } catch {
    const trimmed = text.trim();
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(trimmed)) {
      return { value: trimmed, parseable: true };
    }
    return { value: text.slice(0, 8192), parseable: false };
  }
}

function headersToSanitizedRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    out[lower] =
      lower === "authorization" ||
      lower === "cookie" ||
      lower === "set-cookie" ||
      lower === "payment-signature" ||
      lower === "x-payment"
        ? "[REDACTED]"
        : value;
  });
  return out;
}

async function paymentResponseFromHeaders(
  headers: Headers,
  importModule?: (specifier: string) => Promise<unknown>,
): Promise<{
  readonly paymentEvidence: unknown | null;
  readonly settlementEvidence: unknown | null;
  readonly receipt: unknown | null;
  readonly transactionHash: string | null;
}> {
  const value = headers.get("payment-response") ?? headers.get("x-payment-response");
  if (!value) {
    return {
      paymentEvidence: null,
      settlementEvidence: null,
      receipt: null,
      transactionHash: null,
    };
  }

  let decoded: unknown = null;
  let decodeError: string | null = null;
  try {
    const importFn = importModule ?? ((specifier) => import(specifier));
    const httpModule = (await importFn(
      "../../buyer-client/node_modules/@x402/core/dist/esm/http/index.mjs",
    )) as X402CoreHttpModule;
    decoded = httpModule.decodePaymentResponseHeader
      ? httpModule.decodePaymentResponseHeader(value)
      : null;
  } catch (error) {
    decodeError = error instanceof Error ? error.message : String(error);
  }

  if (!decoded) {
    return {
      paymentEvidence: {
        payment_response_header_present: true,
        decode_error: decodeError ?? "payment response header was not decoded",
      },
      settlementEvidence: null,
      receipt: null,
      transactionHash: null,
    };
  }

  const evidence = decoded;
  const transactionHash = extractTransactionHash(evidence);

  return {
    paymentEvidence: {
      payment_response_header_present: true,
      decoded,
      decode_error: decodeError,
      transaction_hash: transactionHash,
    },
    settlementEvidence: evidence,
    receipt: evidence,
    transactionHash,
  };
}

function extractObservedChainId(value: unknown): string | number | null {
  if (typeof value === "number" || typeof value === "string") {
    return normalizeChainId(value) === 1 ? value : value;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of [
    "chainId",
    "chain_id",
    "chainID",
    "chain",
    "id",
    "result",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "number" || typeof candidate === "string") {
      return candidate;
    }
  }
  for (const candidate of Object.values(record)) {
    const nested = extractObservedChainId(candidate);
    if (nested !== null) return nested;
  }
  return null;
}

function extractTransactionHash(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["transactionHash", "txHash", "hash", "transaction"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && /^0x[0-9a-fA-F]+$/.test(candidate)) {
      return candidate;
    }
  }
  for (const candidate of Object.values(record)) {
    const nested = extractTransactionHash(candidate);
    if (nested) return nested;
  }
  return null;
}
