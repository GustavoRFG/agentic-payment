/**
 * x402-thin-settlement-executor — network-parameterized thin wrapper over shared x402 executor.
 */

import type { DiscoveredSelectedCandidate } from "./discovered-target-to-selected-candidate";
import { parseUsdcDecimalToAtomic } from "./external-x402-get-policy";
import { runPaidQuoteFreshnessPreflight } from "./paid-quote-freshness-preflight";
import {
  validateHumanPaymentAuthorization,
  type HumanPaymentAuthorization,
} from "./validate-human-payment-authorization";
import {
  executeSingleX402Settlement,
  type SingleSettlementExecutionResult,
} from "./x402-single-settlement-executor";
import { planThinSettleRequest } from "./thin-settlement-request-plan";
import {
  assertProfileEnvBeforeSettlement,
  expectedAssetForProfile,
  type X402SettlementProfile,
} from "./x402-settlement-profile";

export interface ThinSettlementExecutionResult {
  readonly ok: boolean;
  readonly status: string;
  readonly httpStatus: number | null;
  readonly paymentAttempted: boolean;
  readonly paymentBearingHttpRequestCount: number;
  readonly responseBodyPreview: string;
  readonly buyerAddress: string;
  readonly network: string;
  readonly facilitatorTransactionHash: string | null;
  readonly facilitatorReceiptPath: string | null;
  readonly facilitatorReceiptParseStatus: string | null;
  readonly attemptId: string;
  readonly intentPath: string;
}

export function buildThinSettlementRequestBody(profile: X402SettlementProfile): unknown {
  if (profile.id === "sepolia") {
    return {
      text: "TrustForge Sepolia settlement proof — single authorized attempt.",
      mode: "full",
    };
  }
  return {};
}

function mapThinResult(
  result: SingleSettlementExecutionResult,
  network: string,
): ThinSettlementExecutionResult {
  return {
    ok: result.ok,
    status: result.status,
    httpStatus: result.httpStatus,
    paymentAttempted: result.paymentAttempted,
    paymentBearingHttpRequestCount: result.paymentBearingHttpRequestCount,
    responseBodyPreview: result.responseBodyPreview,
    buyerAddress: result.buyerAddress,
    network,
    facilitatorTransactionHash: result.facilitatorTransactionHash,
    facilitatorReceiptPath: result.facilitatorReceiptPath,
    facilitatorReceiptParseStatus: result.facilitatorReceipt.parseStatus,
    attemptId: result.attemptId,
    intentPath: result.intentPath,
  };
}

export async function executeThinX402Settlement(input: {
  readonly profile: X402SettlementProfile;
  readonly runDir: string;
  readonly auth: HumanPaymentAuthorization;
  readonly selected: DiscoveredSelectedCandidate;
  readonly authorizationHash: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly skipFreshnessPreflight?: boolean;
  readonly requestBody?: unknown;
}): Promise<ThinSettlementExecutionResult> {
  const env = input.env ?? process.env;
  assertProfileEnvBeforeSettlement(input.profile, env);

  const validation = validateHumanPaymentAuthorization(input.auth, input.selected);
  if (!validation.valid) {
    throw new Error(`BLOCKED_INVALID_PAYMENT_AUTHORIZATION: ${validation.reasons.join("; ")}`);
  }

  if (!input.skipFreshnessPreflight) {
    const preflight = await runPaidQuoteFreshnessPreflight({
      authorized: {
        endpoint: input.selected.endpoint,
        quote_amount_usdc: input.selected.quote_amount_usdc,
        quote_atomic: input.selected.quote_atomic,
        authorized_max_usdc: input.auth.max_usdc,
        pay_to: input.selected.authorized_pay_to,
        network: input.selected.network,
        asset: input.selected.asset,
      },
      fetchImpl: input.fetchImpl,
    });
    if (!preflight.go) {
      throw new Error(`BLOCKED_PAY_TIME_FRESHNESS: ${preflight.reasons.join("; ")}`);
    }
  }

  const maxAmountAtomic = parseUsdcDecimalToAtomic(input.auth.max_usdc).toString();
  const asset = input.selected.asset ?? expectedAssetForProfile(input.profile);
  const body = input.requestBody ?? buildThinSettlementRequestBody(input.profile);

  // A.2: method-aware request shaping via the pre-tested planner. Fail-closed BEFORE
  // any payment — an unsupported method never reaches the shared executor.
  const plan = planThinSettleRequest({
    method: input.selected.method,
    endpoint: input.selected.endpoint,
    body,
  });
  if (!plan.supported) {
    throw new Error(`BLOCKED_METHOD_NOT_SETTLEABLE: ${plan.reason}`);
  }

  const result = await executeSingleX402Settlement({
    request: {
      network: input.selected.network,
      privateKeyEnvName: input.profile.privateKeyEnvName,
      expectedBuyerAddress: input.profile.buyerWallet,
      endpoint: plan.endpoint,
      method: plan.method,
      body: plan.sendBody ? plan.body : undefined,
      asset,
      payTo: input.selected.authorized_pay_to,
      quotedAmountAtomic: input.selected.quote_atomic,
      maxAmountAtomic,
      runDir: input.runDir,
      authorizationHash: input.authorizationHash,
      require402BeforePayment: input.profile.require402BeforePayment,
      expectedNetworkIn402: input.profile.caip2,
    },
    env,
    fetchImpl: input.fetchImpl,
  });

  return mapThinResult(result, input.selected.network);
}
