/**
 * Neutral method/request-shaping contract shared by the thin executor planner
 * and keyless probes.
 */

import {
  requireThinSettlementRequestBinding,
  type ThinSettlementRequestBinding,
} from "./thin-settlement-request-binding";

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

/**
 * The method the thin runner will actually use for a candidate: the explicit catalog
 * method when present, else the backward-compatible POST default. This is the single
 * place that default lives, so the planner, the authorization draft, and the
 * method-binding gate cannot drift apart on what "no declared method" means.
 */
export function resolveEffectiveThinSettlementMethod(
  method: string | null | undefined,
): string {
  return normalizeThinSettlementMethod(method) ?? "POST";
}

export type ThinSettleRequestPlan =
  | {
      readonly supported: true;
      readonly method: ThinRunnerSettleableMethod;
      readonly endpoint: string;
      /** Request body to send, or undefined for verbs that carry no body (GET). */
      readonly body: unknown;
      readonly sendBody: boolean;
      readonly requestBinding: ThinSettlementRequestBinding;
      readonly requestBindingSha256: string;
    }
  | {
      readonly supported: false;
      readonly method: string;
      readonly reason: string;
    };

/**
 * Plans only from a persisted, internally valid binding. There is deliberately no
 * implicit request body (including `{}`) when catalog input is absent.
 */
export function planThinSettleRequest(input: {
  readonly requestBinding: ThinSettlementRequestBinding;
}): ThinSettleRequestPlan {
  const binding = requireThinSettlementRequestBinding(input.requestBinding);
  const method = binding.method;

  if (!isThinRunnerSettleableMethod(method)) {
    return {
      supported: false,
      method,
      reason: `${REJECTED_METHOD_UNSUPPORTED_BY_THIN_RUNNER}: ${method} not settleable by the thin runner (enabled: ${THIN_RUNNER_SETTLEABLE_METHODS.join(", ")})`,
    };
  }

  const url = new URL(binding.endpoint);
  for (const [key, value] of binding.query) url.searchParams.append(key, value);

  if (method === "GET") {
    return {
      supported: true,
      method: "GET",
      endpoint: url.toString(),
      body: undefined,
      sendBody: false,
      requestBinding: binding,
      requestBindingSha256: binding.binding_sha256,
    };
  }

  return {
    supported: true,
    method: "POST",
    endpoint: url.toString(),
    body: binding.body,
    sendBody: true,
    requestBinding: binding,
    requestBindingSha256: binding.binding_sha256,
  };
}
