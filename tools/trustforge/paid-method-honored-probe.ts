/**
 * paid-method-honored-probe — keyless settle-method check after a live 402 handshake.
 *
 * This keyless probe sends POST to the selected endpoint with no payment header
 * and rejects 404/405/501 before adapt commits a candidate. On HTTP 402 it also
 * extracts maxAmountRequired (atomic) for the subsequent quote-stability check.
 */

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { extractMaxAmountRequiredAtomic } from "./quote-stability-probe";
import { startAbortDeadline } from "./abort-deadline";
import { isThinRunnerSettleableMethod } from "./thin-settlement-request-plan";

/** Statuses that mean the settle HTTP method/route is not honored by the seller. */
export const PAID_METHOD_NOT_HONORED_HTTP_STATUSES = new Set([404, 405, 501]);

export const REJECTED_PAID_METHOD_NOT_HONORED = "REJECTED_PAID_METHOD_NOT_HONORED";

/** Catalog method outside the planner-backed thin runner's supported set. */
export const REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER = "REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER";

/**
 * Method used by this keyless POST probe. The method-aware executor separately
 * follows the selected candidate via planThinSettleRequest.
 */
export const SETTLEMENT_PAID_HTTP_METHOD = "POST" as const;

/**
 * Whether the thin runner can settle a candidate declaring `method`. Delegates to the
 * planner's single source of truth (safeguard §4): now the executor is method-aware,
 * POST and GET are supported and PUT/PATCH/DELETE/HEAD (and absent/unknown) are not.
 * Widening this in isolation would re-open the 405 — it lands in the same commit as
 * the executor wiring.
 */
export function isMethodSupportedByThinRunner(method: string | null | undefined): boolean {
  return isThinRunnerSettleableMethod(method);
}

export interface PaidMethodHonoredProbeResult {
  readonly honored: boolean;
  readonly httpStatus: number | null;
  readonly method: typeof SETTLEMENT_PAID_HTTP_METHOD;
  readonly endpoint: string;
  readonly maxAmountRequiredAtomic: string | null;
  readonly reason: string | null;
  readonly walletUsed: false;
  readonly paymentAttempted: false;
}

export interface PaidMethodHonoredProbeOptions {
  readonly endpoint: string;
  readonly expectedNetwork?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly body?: unknown;
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
  const endpoint = options.endpoint;
  const method = SETTLEMENT_PAID_HTTP_METHOD;
  const deadline = startAbortDeadline(timeoutMs);

  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  if (containsX402PaymentHeader(headers)) {
    deadline.clear();
    throw new Error("paid method probe unexpectedly contains a payment header");
  }

  try {
    const response = await fetchImpl(endpoint, {
      method,
      headers,
      body: JSON.stringify(options.body ?? {}),
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
    const maxAmountRequiredAtomic =
      httpStatus === 402
        ? extractMaxAmountRequiredAtomic(
            { headers: lowerHeaders(response.headers), body },
            { expectedNetwork: options.expectedNetwork },
          )
        : null;

    if (PAID_METHOD_NOT_HONORED_HTTP_STATUSES.has(httpStatus)) {
      return {
        honored: false,
        httpStatus,
        method,
        endpoint,
        maxAmountRequiredAtomic: null,
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
      reason: `PAID_METHOD_PROBE_FAILED: settle ${method} ${endpoint} (${message})`,
      walletUsed: false,
      paymentAttempted: false,
    };
  } finally {
    deadline.clear();
  }
}
