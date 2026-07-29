/**
 * Neutral method/request-shaping contract shared by the thin executor planner
 * and keyless probes. This module is pure and intentionally imports nothing.
 */

export const REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER =
  "REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER";

export const THIN_RUNNER_SETTLEABLE_METHODS = ["POST", "GET"] as const;
export type ThinRunnerSettleableMethod = (typeof THIN_RUNNER_SETTLEABLE_METHODS)[number];

export function normalizeThinSettlementMethod(
  method: string | null | undefined,
): string | null {
  const normalized = method?.trim().toUpperCase();
  return normalized && normalized.length > 0 ? normalized : null;
}

export function isThinRunnerSettleableMethod(
  method: string | null | undefined,
): boolean {
  const normalized = normalizeThinSettlementMethod(method);
  return normalized === "POST" || normalized === "GET";
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
    return endpoint;
  }
}

/**
 * Defaults an absent catalog method to POST for backward compatibility. Explicit
 * unsupported methods fail closed. GET carries parameters in the query and no body.
 */
export function planThinSettleRequest(input: {
  readonly method?: string | null;
  readonly endpoint: string;
  readonly body: unknown;
}): ThinSettleRequestPlan {
  const method = normalizeThinSettlementMethod(input.method) ?? "POST";

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

  return {
    supported: true,
    method: "POST",
    endpoint: input.endpoint,
    body: input.body,
    sendBody: true,
  };
}
