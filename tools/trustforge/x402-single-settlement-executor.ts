/**
 * x402-single-settlement-executor — promoted Sepolia-proven signing/send core.
 *
 * privateKeyToAccount, x402Client, registerExactEvmScheme, wrapFetchWithPayment
 * live ONLY here. Neither runner may duplicate them.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import { assertSettlementNetworkGuards } from "./settlement-network-guards";
import {
  buildSettlementIntent,
  type SettlementIntent,
} from "./settlement-run-binding";
import { parseJsonText } from "./bom-safe-json";
import {
  extractAndSanitizeFacilitatorReceipt,
  persistFacilitatorReceiptArtifact,
  type SanitizedFacilitatorReceipt,
} from "./facilitator-settlement-receipt";

export {
  extractFacilitatorHashFromResponse,
  extractFacilitatorHashFromPaymentResponseHeader,
} from "./facilitator-settlement-receipt";

import { assertAuthorizationMethodBinding } from "./authorization-method-binding";
import {
  bindingFromOutboundRequest,
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING,
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH,
  BLOCKED_INTENT_REQUEST_BINDING_MISMATCH,
  BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH,
  requireThinSettlementRequestBinding,
  thinSettlementRequestSummary,
  type ThinSettlementRequestBinding,
} from "./thin-settlement-request-binding";

export interface SingleSettlementRequest {
  readonly network: string;
  readonly privateKeyEnvName: string;
  readonly expectedBuyerAddress: string;
  readonly endpoint: string;
  readonly method: "GET" | "POST";
  /**
   * Pre-live method binding: the method the human authorized. It must equal `method`
   * and the method stamped into the intent, or the attempt is blocked before any
   * payment-bearing work. Callers must provide it explicitly; the shared executor
   * never infers authorization from the request it is about to send.
   */
  readonly authorizedMethod: string | null;
  /** Human-authorized request-shape hash. Never inferred from the planned request. */
  readonly authorizedRequestBindingSha256: string | null;
  /** Canonical request shape produced by the caller's planner. */
  readonly plannedRequestBinding: ThinSettlementRequestBinding | null;
  readonly body?: unknown;
  readonly asset: string;
  readonly payTo: string;
  readonly quotedAmountAtomic: string;
  readonly maxAmountAtomic: string;
  readonly facilitatorUrl?: string;
  readonly runDir: string;
  readonly authorizationHash: string;
  readonly attemptId?: string;
  readonly runId?: string;
  readonly requestId?: string;
  readonly registerNetworks?: readonly string[];
  readonly require402BeforePayment?: boolean;
  readonly expectedNetworkIn402?: string;
}

export interface SingleSettlementExecutionResult {
  readonly ok: boolean;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly responseStatus: number | null;
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly responseBody: string;
  readonly responseBodyPreview: string;
  readonly responseHeaders: Headers;
  readonly buyerAddress: string;
  readonly network: string;
  readonly facilitatorTransactionHash: string | null;
  readonly facilitatorReceipt: SanitizedFacilitatorReceipt;
  readonly facilitatorReceiptPath: string | null;
  readonly facilitatorReceiptPersistError: string | null;
  readonly attemptId: string;
  readonly intent: SettlementIntent;
  readonly intentPath: string;
  readonly requestBinding: {
    readonly authorization_request_binding_sha256: string;
    readonly selected_candidate_request_binding_sha256: string;
    readonly planned_request_binding_sha256: string;
    readonly intent_request_binding_sha256: string;
    readonly outbound_request_binding_sha256: string;
  };
}

export interface PaymentRequiredIntentSpec {
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amountAtomic: string;
}

export function decodePaymentRequiredHeader(value: string): { accepts?: Array<Record<string, unknown>> } {
  const decoded = Buffer.from(value, "base64").toString("utf-8");
  return parseJsonText<{ accepts?: Array<Record<string, unknown>> }>(decoded);
}

function acceptAmountAtomic(entry: Record<string, unknown>): string {
  return String(entry.amount ?? entry.maxAmountRequired ?? entry.maxAmount ?? "");
}

function acceptPayTo(entry: Record<string, unknown>): string {
  return String(entry.payTo ?? entry.pay_to ?? "").toLowerCase();
}

export function assertPaymentRequiredRailMatchesIntent(
  envelope: { accepts?: Array<Record<string, unknown>> },
  intent: PaymentRequiredIntentSpec,
  expectedNetwork?: string,
): void {
  const network = expectedNetwork ?? intent.network;
  const accepts = envelope.accepts ?? [];
  const rail = accepts.find((entry) => entry.network === network);
  if (!rail) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: network");
  }
  if (String(rail.asset ?? "").toLowerCase() !== intent.asset.toLowerCase()) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: asset");
  }
  if (acceptPayTo(rail) !== intent.payTo.toLowerCase()) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: pay_to");
  }
  if (acceptAmountAtomic(rail) !== intent.amountAtomic) {
    throw new Error("BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH: amount");
  }
}

export function extractFacilitatorTransactionHash(response: Response): string | null {
  return extractAndSanitizeFacilitatorReceipt(response).transactionHash;
}

export async function persistSettlementIntent(
  runDir: string,
  intent: SettlementIntent,
): Promise<string> {
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, `settlement_intent_${intent.attempt_id}.json`);
  await writeFile(path, `${JSON.stringify(intent, null, 2)}\n`, "utf8");
  return path;
}

export async function executeSingleX402Settlement(input: {
  readonly request: SingleSettlementRequest;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly paidInvocationGuard?: ReturnType<typeof createPaidInvocationGuard>;
  readonly paymentBearingGuard?: ReturnType<typeof createPaymentBearingRequestGuard>;
}): Promise<SingleSettlementExecutionResult> {
  const env = input.env ?? process.env;
  const req = input.request;
  // Pre-live method binding, checked before the key is even read: an authorization for
  // one verb must never reach the signing path for another.
  assertAuthorizationMethodBinding({
    authorizationMethod: req.authorizedMethod,
    candidateMethod: req.method,
    plannedMethod: req.method,
  });

  const authorizedRequestBindingSha256 =
    req.authorizedRequestBindingSha256?.trim().toLowerCase();
  if (!authorizedRequestBindingSha256) {
    throw new Error(
      `${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING}: shared executor requires explicit authorization binding`,
    );
  }
  if (!req.plannedRequestBinding) {
    throw new Error(
      `${BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH}: planned request binding missing`,
    );
  }
  let plannedRequestBinding: ThinSettlementRequestBinding;
  try {
    plannedRequestBinding = requireThinSettlementRequestBinding(req.plannedRequestBinding);
  } catch (error) {
    throw new Error(
      `${BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (authorizedRequestBindingSha256 !== plannedRequestBinding.binding_sha256) {
    throw new Error(
      `${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH}: authorization differs from planned request`,
    );
  }
  const outboundRequestBinding = bindingFromOutboundRequest({
    endpoint: req.endpoint,
    method: req.method,
    body: req.method === "GET" ? null : req.body,
  });
  if (outboundRequestBinding.binding_sha256 !== plannedRequestBinding.binding_sha256) {
    throw new Error(
      `${BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH}: planned request differs from outbound request`,
    );
  }

  if (BigInt(req.quotedAmountAtomic) > BigInt(req.maxAmountAtomic)) {
    throw new Error(
      `BLOCKED_QUOTE_EXCEEDS_MAX: quote ${req.quotedAmountAtomic} > max ${req.maxAmountAtomic}`,
    );
  }

  const attemptId = req.attemptId ?? `attempt_${randomUUID()}`;
  const runId = req.runId ?? attemptId;
  const intent = buildSettlementIntent({
    attemptId,
    runId,
    authorizationHash: req.authorizationHash,
    network: req.network,
    buyer: req.expectedBuyerAddress,
    payTo: req.payTo,
    asset: req.asset,
    amountAtomic: req.quotedAmountAtomic,
    method: req.method,
    requestBindingSha256: plannedRequestBinding.binding_sha256,
    requestSummary: thinSettlementRequestSummary(plannedRequestBinding),
  });
  // Intent-bound leg of the same gate: the persisted intent now carries the verb, so
  // the authorized method is also checked against what this attempt will actually
  // send, before the 402 handshake and before any payment header exists.
  assertAuthorizationMethodBinding({
    authorizationMethod: req.authorizedMethod,
    candidateMethod: req.method,
    plannedMethod: req.method,
    intentMethod: intent.method,
  });
  if (intent.request_binding_sha256 !== plannedRequestBinding.binding_sha256) {
    throw new Error(
      `${BLOCKED_INTENT_REQUEST_BINDING_MISMATCH}: intent differs from planned request`,
    );
  }

  // All authorization/planner/intent/outbound request-shape gates above run before
  // this call, which is the first operation allowed to read the private key.
  const { privateKey, buyerAddress, chainId: _chainId } = assertSettlementNetworkGuards({
    network: req.network,
    privateKeyEnvName: req.privateKeyEnvName,
    expectedBuyerAddress: req.expectedBuyerAddress,
    asset: req.asset,
    env,
  });
  const intentPath = await persistSettlementIntent(req.runDir, intent);

  const fetchImpl = input.fetchImpl ?? fetch;
  const requestId = req.requestId ?? randomUUID();
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  if (req.method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["X-Agentic-Request-Id"] = requestId;
  }

  if (req.require402BeforePayment) {
    const unpaid = await fetchImpl(req.endpoint, {
      method: req.method,
      headers,
      body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
      redirect: "manual",
    });
    if (unpaid.status !== 402) {
      throw new Error(`BLOCKED_PRE_PAYMENT_402: expected 402, got ${unpaid.status}`);
    }
    const rawHeader =
      unpaid.headers.get("payment-required") ?? unpaid.headers.get("PAYMENT-REQUIRED");
    if (!rawHeader) {
      throw new Error("BLOCKED_PRE_PAYMENT_402: missing PAYMENT-REQUIRED header");
    }
    const envelope = decodePaymentRequiredHeader(rawHeader);
    assertPaymentRequiredRailMatchesIntent(
      envelope,
      {
        network: req.expectedNetworkIn402 ?? req.network,
        asset: req.asset,
        payTo: req.payTo,
        amountAtomic: req.quotedAmountAtomic,
      },
      req.expectedNetworkIn402 ?? req.network,
    );
  }

  const paidInvocationGuard =
    input.paidInvocationGuard ?? createPaidInvocationGuard({ maxAttempts: 1 });
  const paymentBearingGuard =
    input.paymentBearingGuard ?? createPaymentBearingRequestGuard({ maxPaymentBearingRequests: 1 });

  const signer = privateKeyToAccount(privateKey as `0x${string}`);
  const client = new x402Client();
  if (req.registerNetworks && req.registerNetworks.length > 0) {
    registerExactEvmScheme(client, {
      signer,
      networks: [...req.registerNetworks],
    });
  } else {
    registerExactEvmScheme(client, { signer });
  }

  const guardedFetch: typeof fetch = async (reqInput, init) => {
    paymentBearingGuard.inspectRequest(reqInput, init);
    return fetchImpl(reqInput, init);
  };
  const fetchWithPayment = wrapFetchWithPayment(guardedFetch, client);

  paidInvocationGuard.assertNext();
  const response = await fetchWithPayment(req.endpoint, {
    method: req.method,
    headers,
    body: req.method === "POST" ? JSON.stringify(req.body) : undefined,
    redirect: "manual",
  });

  const body = await response.text();
  const paymentBearingCount = paymentBearingGuard.getPaymentBearingRequests();
  const ok = response.status >= 200 && response.status < 300;
  const facilitatorReceipt = extractAndSanitizeFacilitatorReceipt(response, body);
  const facilitatorTransactionHash = facilitatorReceipt.transactionHash;

  let facilitatorReceiptPath: string | null = null;
  let facilitatorReceiptPersistError: string | null = null;
  try {
    facilitatorReceiptPath = await persistFacilitatorReceiptArtifact({
      runDir: req.runDir,
      attemptId,
      runId,
      receipt: facilitatorReceipt,
    });
  } catch (error) {
    facilitatorReceiptPersistError =
      error instanceof Error ? error.message : "FACILITATOR_RECEIPT_PERSIST_FAILED";
  }

  return {
    ok,
    status: ok ? "SETTLEMENT_HTTP_OK" : "SETTLEMENT_HTTP_FAIL",
    httpStatus: response.status,
    responseStatus: response.status,
    paymentAttempted: paymentBearingCount > 0,
    paymentBearingHttpRequestCount: paymentBearingCount,
    responseBody: body,
    responseBodyPreview: body.slice(0, 500),
    responseHeaders: response.headers,
    buyerAddress,
    network: req.network,
    facilitatorTransactionHash,
    facilitatorReceipt,
    facilitatorReceiptPath,
    facilitatorReceiptPersistError,
    attemptId,
    intent,
    intentPath,
    requestBinding: {
      authorization_request_binding_sha256: authorizedRequestBindingSha256,
      selected_candidate_request_binding_sha256: plannedRequestBinding.binding_sha256,
      planned_request_binding_sha256: plannedRequestBinding.binding_sha256,
      intent_request_binding_sha256: intent.request_binding_sha256!,
      outbound_request_binding_sha256: outboundRequestBinding.binding_sha256,
    },
  };
}
