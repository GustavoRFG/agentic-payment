import { PAYMENT_AMOUNT_USD } from "../../shared/payment-safety";

export function assertSepoliaQuoteWithinMax(quoteUsdc: string, maxUsdc: string): void {
  const quote = Number.parseFloat(quoteUsdc);
  const max = Number.parseFloat(maxUsdc);
  if (!Number.isFinite(quote) || quote > max) {
    throw new Error(`quote ${quoteUsdc} exceeds max ${maxUsdc}`);
  }
  void PAYMENT_AMOUNT_USD;
}
