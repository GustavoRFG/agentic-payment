/**
 * facilitator-receipt-parse — extract settlement tx hash from sanitized payment-response headers.
 */

export function decodeBase64PaymentPayload(value: string): Record<string, unknown> | null {
  try {
    const padded = value
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(value.length / 4) * 4, "=");
    const decoded = Buffer.from(padded, "base64").toString("utf-8");
    const parsed = JSON.parse(decoded) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function extractTransactionHashFromPaymentPayload(
  payload: Record<string, unknown>,
): string | null {
  const tx =
    payload.transactionHash ??
    payload.transaction_hash ??
    (payload.transaction as Record<string, unknown> | undefined)?.hash;
  if (typeof tx !== "string") return null;
  const trimmed = tx.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function extractFacilitatorHashFromPaymentResponseHeader(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue?.trim()) return null;
  const trimmed = headerValue.trim();
  if (trimmed.startsWith("{")) {
    try {
      const direct = JSON.parse(trimmed) as Record<string, unknown>;
      return extractTransactionHashFromPaymentPayload(direct);
    } catch {
      return null;
    }
  }
  const decoded = decodeBase64PaymentPayload(trimmed);
  if (!decoded) return null;
  return extractTransactionHashFromPaymentPayload(decoded);
}

export function extractFacilitatorHashFromResponse(response: Response): string | null {
  const paymentHeader =
    response.headers.get("payment-response") ?? response.headers.get("x-payment-response");
  return extractFacilitatorHashFromPaymentResponseHeader(paymentHeader);
}
