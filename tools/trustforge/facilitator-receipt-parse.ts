/**
 * facilitator-receipt-parse — legacy re-exports; use facilitator-settlement-receipt.ts.
 */

export {
  decodeReceiptPayload,
  extractAndSanitizeFacilitatorReceipt,
  extractFacilitatorHashFromPaymentResponseHeader,
  extractFacilitatorHashFromResponse,
  normalizeTransactionHash,
  type SanitizedFacilitatorReceipt,
} from "./facilitator-settlement-receipt";

/** @deprecated use decodeReceiptPayload */
export function decodeBase64PaymentPayload(value: string): Record<string, unknown> | null {
  try {
    const decoded = JSON.parse(
      typeof value === "string" && value.trim().startsWith("{")
        ? value
        : Buffer.from(
            value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="),
            "base64",
          ).toString("utf-8"),
    ) as unknown;
    return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** @deprecated use normalizeTransactionHash via facilitator-settlement-receipt */
export function extractTransactionHashFromPaymentPayload(
  payload: Record<string, unknown>,
): string | null {
  const tx =
    payload.transaction ??
    payload.transactionHash ??
    payload.transaction_hash ??
    (payload.transaction as Record<string, unknown> | undefined)?.hash;
  if (typeof tx !== "string") return null;
  const trimmed = tx.trim();
  return /^0x[0-9a-fA-F]{64}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}
