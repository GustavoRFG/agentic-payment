/**
 * thin-settlement-request-plan — A.2 core: method-aware paid-request shaping.
 *
 * Pure, side-effect-free planner (no key, no wallet, no network, no payment) that
 * turns a selected candidate's catalog method into the shape the paid settle
 * request should take. It is the reviewable, tested component of A.2; wiring it
 * into the money-moving executor (x402-thin-settlement-executor.ts) is the
 * deliberate human-review step and is NOT done here — the executor stays untouched.
 *
 * Enabled verbs (spec §37): POST and GET only. PUT/PATCH/DELETE/HEAD stay gated
 * until reviewed per-method, so a non-settleable method returns supported:false and
 * the caller must not settle.
 *
 * Verb/body handling (spec §28):
 *   - POST carries the JSON body at the endpoint.
 *   - GET carries no body; required parameters move to the query string (mirroring
 *     the keyless GET handshake).
 */

import { REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER } from "./paid-method-honored-probe";

/** HTTP methods the thin runner is able to settle (spec §37: POST + GET first). */
export const THIN_RUNNER_SETTLEABLE_METHODS = ["POST", "GET"] as const;
export type ThinRunnerSettleableMethod = (typeof THIN_RUNNER_SETTLEABLE_METHODS)[number];

export function isThinRunnerSettleableMethod(
  method: string | null | undefined,
): method is ThinRunnerSettleableMethod {
  if (!method) return false;
  return (THIN_RUNNER_SETTLEABLE_METHODS as readonly string[]).includes(method.toUpperCase());
}

export type ThinSettleRequestPlan =
  | {
      readonly supported: true;
      readonly method: ThinRunnerSettleableMethod;
      readonly endpoint: string;
      /** Request body to send, or undefined for verbs that carry no body (GET). */
      readonly body: unknown;
      readonly sendBody: boolean;
    }
  | {
      readonly supported: false;
      readonly method: string;
      readonly reason: string;
    };

/** Append flat body params to the endpoint's query string (GET/HEAD). Absolute URLs only. */
function appendQueryParams(endpoint: string, body: unknown): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return endpoint;
  const entries = Object.entries(body as Record<string, unknown>).filter(
    ([, value]) => value !== undefined && value !== null,
  );
  if (entries.length === 0) return endpoint;
  try {
    const url = new URL(endpoint);
    for (const [key, value] of entries) url.searchParams.set(key, String(value));
    return url.toString();
  } catch {
    // Non-absolute endpoint: leave untouched rather than corrupt it.
    return endpoint;
  }
}

/**
 * Plan the paid settle request for a candidate. Defaults to POST when the catalog
 * declares no method (preserving today's behavior exactly). A non-settleable method
 * yields supported:false with REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER — the
 * caller must not attempt payment.
 */
export function planThinSettleRequest(input: {
  readonly method?: string | null;
  readonly endpoint: string;
  readonly body: unknown;
}): ThinSettleRequestPlan {
  const method = (input.method ?? "POST").toUpperCase();

  if (!isThinRunnerSettleableMethod(method)) {
    return {
      supported: false,
      method,
      reason: `${REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER}: ${method} not settleable by the thin runner (enabled: ${THIN_RUNNER_SETTLEABLE_METHODS.join(", ")})`,
    };
  }

  if (method === "GET") {
    return {
      supported: true,
      method: "GET",
      endpoint: appendQueryParams(input.endpoint, input.body),
      body: undefined,
      sendBody: false,
    };
  }

  // POST (and the default) carries the JSON body at the endpoint unchanged.
  return {
    supported: true,
    method: "POST",
    endpoint: input.endpoint,
    body: input.body,
    sendBody: true,
  };
}
