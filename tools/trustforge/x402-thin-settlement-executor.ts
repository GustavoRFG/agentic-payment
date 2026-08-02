/**
 * x402-thin-settlement-executor — network-parameterized thin wrapper over shared x402 executor.
 */

import {
  requestBindingFromSelectedCandidate,
  type DiscoveredSelectedCandidate,
} from "./discovered-target-to-selected-candidate";
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
import {
  isThinRunnerSettleableMethod,
  planThinSettleRequest,
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
} from "./thin-settlement-request-plan";
import {
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING,
  BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH,
  BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH,
} from "./thin-settlement-request-binding";
import {
  assertAuthorizationMethodBinding,
  type AuthorizationMethodBindingEvidence,
} from "./authorization-method-binding";
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
  /** Auditable method chain: candidate, authorization, planner, request, intent. */
  readonly methodBinding: AuthorizationMethodBindingEvidence & {
    readonly request_method: string;
  };
  readonly requestBinding: SingleSettlementExecutionResult["requestBinding"];
}

export function buildThinSettlementRequestBody(profile: X402SettlementProfile): unknown {
  throw new Error(
    `REJECTED_REQUEST_BINDING_NOT_PERSISTED: ${profile.id} request body fallback is disabled`,
  );
}

function mapThinResult(
  result: SingleSettlementExecutionResult,
  network: string,
  methodBinding: ThinSettlementExecutionResult["methodBinding"],
): ThinSettlementExecutionResult {
  return {
    methodBinding,
    requestBinding: result.requestBinding,
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
}): Promise<ThinSettlementExecutionResult> {
  const env = input.env ?? process.env;
  assertProfileEnvBeforeSettlement(input.profile, env);

  if (!isThinRunnerSettleableMethod(input.selected.method)) {
    throw new Error(
      `BLOCKED_METHOD_NOT_SETTLEABLE: ${REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER}: ${String(input.selected.method)} not settleable by the thin runner`,
    );
  }
  assertAuthorizationMethodBinding({
    authorizationMethod: input.auth.method,
    candidateMethod: input.selected.method,
  });

  const validation = validateHumanPaymentAuthorization(input.auth, input.selected);
  if (!validation.valid) {
    throw new Error(`BLOCKED_INVALID_PAYMENT_AUTHORIZATION: ${validation.reasons.join("; ")}`);
  }

  const requestBinding = requestBindingFromSelectedCandidate(input.selected);
  const authorizedRequestBinding = input.auth.request_binding_sha256?.trim().toLowerCase();
  if (!authorizedRequestBinding) {
    throw new Error(`${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING}: authorization hash absent`);
  }
  if (authorizedRequestBinding !== requestBinding.binding_sha256) {
    throw new Error(
      `${BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH}: authorization differs from selected_candidate`,
    );
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
        request_binding: requestBinding,
      },
      fetchImpl: input.fetchImpl,
    });
    if (!preflight.go) {
      throw new Error(`BLOCKED_PAY_TIME_FRESHNESS: ${preflight.reasons.join("; ")}`);
    }
  }

  const maxAmountAtomic = parseUsdcDecimalToAtomic(input.auth.max_usdc).toString();
  const asset = input.selected.asset ?? expectedAssetForProfile(input.profile);
  // A.2: method-aware request shaping via the pre-tested planner. Fail-closed BEFORE
  // any payment — an unsupported method never reaches the shared executor.
  const plan = planThinSettleRequest({
    requestBinding,
  });
  if (!plan.supported) {
    throw new Error(`BLOCKED_METHOD_NOT_SETTLEABLE: ${plan.reason}`);
  }
  if (plan.requestBindingSha256 !== requestBinding.binding_sha256) {
    throw new Error(
      `${BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH}: planner differs from selected_candidate`,
    );
  }

  // Pre-live method binding gate. Throws BEFORE the shared executor is reached, so a
  // cross-method authorization can never load a key, sign, or send a payment header.
  const bindingEvidence = assertAuthorizationMethodBinding({
    authorizationMethod: input.auth.method,
    candidateMethod: input.selected.method,
    plannedMethod: plan.method,
  });
  const methodBinding = {
    ...bindingEvidence,
    planned_method: plan.method,
    intent_method: plan.method,
    request_method: plan.method,
  };

  const result = await executeSingleX402Settlement({
    request: {
      network: input.selected.network,
      privateKeyEnvName: input.profile.privateKeyEnvName,
      expectedBuyerAddress: input.profile.buyerWallet,
      endpoint: plan.endpoint,
      method: plan.method,
      authorizedMethod: input.auth.method!,
      authorizedRequestBindingSha256: authorizedRequestBinding,
      plannedRequestBinding: plan.requestBinding,
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

  return mapThinResult(result, input.selected.network, methodBinding);
}
