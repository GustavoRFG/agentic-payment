/**
 * buyer-payment-bearing-http-transport — authorized HTTP mechanics only.
 *
 * Receives a fully prepared request after PSA validation + send commit.
 * Does not select seller, amount, sign, retry, or follow redirects with payment headers.
 */

import {
  AMBIGUOUS_SEND_TERMINAL_RECONCILE,
  BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST,
} from "./b37-execution-gates";
import {
  BLOCKED_B371_REDIRECT_NOT_ALLOWED,
  BLOCKED_B371_TRANSPORT_FAILED,
  GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE,
} from "./b371-execution-gates";

export interface PreparedPaymentBearingRequest {
  readonly url: string;
  readonly method: "GET" | "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | null;
}

export type PaymentBearingTransportOutcome =
  | {
      readonly kind: "response_observed";
      readonly status: number;
      readonly redirected: false;
      readonly body_text: string;
      readonly observed_at: string;
    }
  | {
      readonly kind: "ambiguous";
      readonly reason:
        | "timeout"
        | "connection_reset"
        | "aborted"
        | "response_lost"
        | "transport_error"
        | "redirect";
      readonly detail: string;
      readonly disposition: typeof AMBIGUOUS_SEND_TERMINAL_RECONCILE;
    };

export interface PaymentBearingHttpTransport {
  invokeOnce(request: PreparedPaymentBearingRequest): Promise<PaymentBearingTransportOutcome>;
  readonly invocationCount: number;
}

function fail(code: string, detail: string): never {
  throw new Error(`${code}: ${detail}`);
}

/** Production fetch transport: redirect manual, no header logging, one-shot. */
export function createFetchPaymentBearingHttpTransport(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): PaymentBearingHttpTransport {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? 30_000;
  let invocationCount = 0;

  return {
    get invocationCount() {
      return invocationCount;
    },
    async invokeOnce(request) {
      if (invocationCount >= 1) {
        fail(
          BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST,
          "PaymentBearingHttpTransport forbids a second invocation",
        );
      }
      invocationCount += 1;

      // Never log headers — payment header is sensitive.
      void GUARD_NO_PAYMENT_HEADER_SECRET_LEAKAGE;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const init: RequestInit = {
          method: request.method,
          headers: { ...request.headers },
          body: request.body,
          redirect: "manual",
          signal: controller.signal,
        };
        const response = await fetchImpl(request.url, init);
        // Manual redirect: 3xx must fail closed (never forward payment header).
        if (response.status >= 300 && response.status < 400) {
          return {
            kind: "ambiguous",
            reason: "redirect",
            detail: `${BLOCKED_B371_REDIRECT_NOT_ALLOWED}: status ${response.status}`,
            disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
          };
        }
        const body_text = await response.text();
        return {
          kind: "response_observed",
          status: response.status,
          redirected: false,
          body_text,
          observed_at: new Date().toISOString(),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const name = error instanceof Error ? error.name : "";
        if (name === "AbortError" || /aborted|timeout/i.test(message)) {
          return {
            kind: "ambiguous",
            reason: "timeout",
            detail: message.split("\n")[0]!,
            disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
          };
        }
        if (/ECONNRESET|socket hang up|network/i.test(message)) {
          return {
            kind: "ambiguous",
            reason: "connection_reset",
            detail: message.split("\n")[0]!,
            disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
          };
        }
        return {
          kind: "ambiguous",
          reason: "transport_error",
          detail: `${BLOCKED_B371_TRANSPORT_FAILED}: ${message.split("\n")[0]}`,
          disposition: AMBIGUOUS_SEND_TERMINAL_RECONCILE,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Injected transport for unit tests / controlled outcomes. */
export function createInjectedPaymentBearingHttpTransport(
  handler: (request: PreparedPaymentBearingRequest) => Promise<PaymentBearingTransportOutcome>,
): PaymentBearingHttpTransport {
  let invocationCount = 0;
  return {
    get invocationCount() {
      return invocationCount;
    },
    async invokeOnce(request) {
      if (invocationCount >= 1) {
        fail(
          BLOCKED_B37_SECOND_PAYMENT_BEARING_REQUEST,
          "injected transport forbids a second invocation",
        );
      }
      invocationCount += 1;
      return handler(request);
    },
  };
}
