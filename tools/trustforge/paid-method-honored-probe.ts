/**
 * paid-method-honored-probe — keyless settle-method check after a live 402 handshake.
 *
 * Uses the selected candidate's planned POST/GET request shape with no payment
 * header and rejects 404/405/501 before adapt commits a candidate. On HTTP 402 it
 * also extracts maxAmountRequired (atomic) for the quote-stability check.
 */

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { extractBoundQuote } from "./quote-stability-probe";
import { startAbortDeadline } from "./abort-deadline";
import {
  isThinRunnerSettleableMethod,
  planThinSettleRequest,
} from "./thin-settlement-method-contract";
import type { ThinSettlementRequestBinding } from "./thin-settlement-request-binding";
import type { SellerRequirementsObservation } from "./x402-seller-requirements-binding";
export {
  REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER,
} from "./thin-settlement-method-contract";

/** Statuses that mean the settle HTTP method/route is not honored by the seller. */
export const PAID_METHOD_NOT_HONORED_HTTP_STATUSES = new Set([404, 405, 501]);

export const REJECTED_PAID_METHOD_NOT_HONORED = "REJECTED_PAID_METHOD_NOT_HONORED";

/**
 * Backward-compatible default when a catalog method is absent. Explicit methods
 * are planned through the neutral contract.
 */
export const SETTLEMENT_PAID_HTTP_METHOD = "POST" as const;

/**
 * Whether the thin runner can settle a candidate declaring `method`. Delegates to the
 * neutral method contract (safeguard §4) — the single source of truth shared with the
 * planner and the executor, so no module re-derives the enabled verb set. POST and GET
 * are supported; PUT/PATCH/DELETE/HEAD (and absent/unknown) are not. Widening the set
 * belongs in the contract, alongside the executor support that makes it settleable.
 */
export function isMethodSupportedByThinRunner(method: string | null | undefined): boolean {
  return isThinRunnerSettleableMethod(method);
}

export interface PaidMethodHonoredProbeResult {
  readonly honored: boolean;
  readonly httpStatus: number | null;
  readonly method: string;
  readonly endpoint: string;
  readonly maxAmountRequiredAtomic: string | null;
  readonly sellerRequirements: SellerRequirementsObservation | null;
  readonly sellerRequirementsError: string | null;
  readonly reason: string | null;
  readonly walletUsed: false;
  readonly paymentAttempted: false;
}

export interface PaidMethodHonoredProbeOptions {
  readonly requestBinding: ThinSettlementRequestBinding;
  readonly expectedNetwork?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly now?: Date;
}

function lowerHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export async function probePaidMethodHonored(
  options: PaidMethodHonoredProbeOptions,
): Promise<PaidMethodHonoredProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const plan = planThinSettleRequest({
    requestBinding: options.requestBinding,
  });
  if (!plan.supported) {
    return {
      honored: false,
      httpStatus: null,
      method: plan.method,
      endpoint: options.requestBinding.endpoint,
      maxAmountRequiredAtomic: null,
      sellerRequirements: null,
      sellerRequirementsError: null,
      reason: plan.reason,
      walletUsed: false,
      paymentAttempted: false,
    };
  }

  const endpoint = plan.endpoint;
  const method = plan.method;
  const deadline = startAbortDeadline(timeoutMs);

  const headers = new Headers({
    accept: "application/json",
  });
  if (plan.sendBody) headers.set("content-type", "application/json");
  if (containsX402PaymentHeader(headers)) {
    deadline.clear();
    throw new Error("paid method probe unexpectedly contains a payment header");
  }

  try {
    const response = await fetchImpl(endpoint, {
      method,
      headers,
      body: plan.sendBody ? JSON.stringify(plan.body) : undefined,
      redirect: "manual",
      signal: deadline.signal,
    });
    const httpStatus = response.status;
    const bodyText = await response.text();
    let body: unknown = null;
    if (bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = { rawText: bodyText.slice(0, 2000) };
      }
    }
    const bound =
      httpStatus === 402
        ? extractBoundQuote(
            { headers: lowerHeaders(response.headers), body },
            {
              expectedNetwork: options.expectedNetwork,
              requestBindingSha256: options.requestBinding.binding_sha256,
              requirementsObservedAt: options.now ?? new Date(),
            },
          )
        : null;
    const maxAmountRequiredAtomic = bound?.atomic ?? null;

    if (PAID_METHOD_NOT_HONORED_HTTP_STATUSES.has(httpStatus)) {
      return {
        honored: false,
        httpStatus,
        method,
        endpoint,
        maxAmountRequiredAtomic: null,
        sellerRequirements: null,
        sellerRequirementsError: bound?.sellerRequirementsError ?? null,
        reason: `${REJECTED_PAID_METHOD_NOT_HONORED}: settle ${method} ${endpoint} returned HTTP ${httpStatus}`,
        walletUsed: false,
        paymentAttempted: false,
      };
    }
    return {
      honored: true,
      httpStatus,
      method,
      endpoint,
      maxAmountRequiredAtomic,
      sellerRequirements: bound?.sellerRequirements ?? null,
      sellerRequirementsError: bound?.sellerRequirementsError ?? null,
      reason: null,
      walletUsed: false,
      paymentAttempted: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      honored: false,
      httpStatus: null,
      method,
      endpoint,
      maxAmountRequiredAtomic: null,
      sellerRequirements: null,
      sellerRequirementsError: null,
      reason: `PAID_METHOD_PROBE_FAILED: settle ${method} ${endpoint} (${message})`,
      walletUsed: false,
      paymentAttempted: false,
    };
  } finally {
    deadline.clear();
  }
}
