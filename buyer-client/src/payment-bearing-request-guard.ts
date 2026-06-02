/**
 * Agentic Payments Lab — buyer-client (MVP 003B.0.2).
 *
 * Caps the number of **payment-bearing HTTP requests** that may leave the
 * process, independent of how the installed `@x402/fetch` wrapper sequences its
 * internal protocol requests.
 *
 * The installed x402 version attaches the payment signature to the follow-up
 * request using one of these outbound headers (see
 * `@x402/core/dist/cjs/client/index.js` -> `encodePaymentSignatureHeader`):
 *
 *   - `PAYMENT-SIGNATURE`  (x402 protocol v2, the current default)
 *   - `X-PAYMENT`          (x402 protocol v1)
 *
 * These exact names are also the ones the wrapper itself checks for its
 * "Payment already attempted" duplicate guard. We match either, case-insensitively.
 *
 * This module is side-effect free: it inspects header *names* only and never
 * reads, copies, or logs any header *value* (which would be the payment
 * signature / authorization payload).
 */

import { MAX_PAYMENT_ATTEMPTS } from "../../shared/payment-safety";

/**
 * Outbound payment-bearing header names used by the installed x402 version.
 * Stored lower-cased for case-insensitive comparison.
 */
const X402_PAYMENT_HEADER_NAMES: readonly string[] = [
  "payment-signature", // x402 v2 (default)
  "x-payment", // x402 v1
];

export interface PaymentBearingRequestGuard {
  /** Inspect one outbound request's headers; throws if it would exceed the cap. */
  inspect(headers?: HeadersInit): void;
  /** Number of payment-bearing requests observed so far. */
  getPaymentBearingRequests(): number;
}

/**
 * Returns true when `headers` carries an x402 payment-bearing header.
 *
 * Normalizes the three `HeadersInit` shapes (Headers, Record, tuple array) and
 * compares header names case-insensitively. Header *values* are never inspected
 * or logged.
 */
export function containsX402PaymentHeader(headers?: HeadersInit): boolean {
  if (!headers) return false;

  const hasName = (name: string): boolean =>
    X402_PAYMENT_HEADER_NAMES.includes(name.trim().toLowerCase());

  if (headers instanceof Headers) {
    // forEach is (value, name); we read only the name, never the value.
    let found = false;
    headers.forEach((_value, name) => {
      if (hasName(name)) found = true;
    });
    return found;
  }

  if (Array.isArray(headers)) {
    // [string, string][]
    for (const entry of headers) {
      if (Array.isArray(entry) && entry.length > 0 && hasName(String(entry[0]))) {
        return true;
      }
    }
    return false;
  }

  // Record<string, string>
  for (const name of Object.keys(headers)) {
    if (hasName(name)) return true;
  }
  return false;
}

/**
 * Creates a guard that refuses more than `maxPaymentBearingRequests`
 * payment-bearing HTTP requests (default: MAX_PAYMENT_ATTEMPTS = 1).
 */
export function createPaymentBearingRequestGuard(
  maxPaymentBearingRequests = MAX_PAYMENT_ATTEMPTS,
): PaymentBearingRequestGuard {
  let paymentBearingRequests = 0;

  return {
    inspect(headers?: HeadersInit): void {
      if (!containsX402PaymentHeader(headers)) return;

      paymentBearingRequests += 1;

      if (paymentBearingRequests > maxPaymentBearingRequests) {
        throw new Error("refusing more than one payment-bearing HTTP request");
      }
    },

    getPaymentBearingRequests(): number {
      return paymentBearingRequests;
    },
  };
}
