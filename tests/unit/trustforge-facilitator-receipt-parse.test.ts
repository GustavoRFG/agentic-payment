import { describe, expect, it } from "vitest";
import {
  extractFacilitatorHashFromPaymentResponseHeader,
  extractFacilitatorHashFromResponse,
} from "../../tools/trustforge/facilitator-receipt-parse";

const TX = "0x9ce1e957b4547ee86559e8b32af4a9a6e7087f8330096fde618abe4ea9ccf9a9";

describe("facilitator-receipt-parse", () => {
  it("extracts tx hash from base64 payment-response JSON", () => {
    const payload = Buffer.from(JSON.stringify({ transactionHash: TX })).toString("base64");
    expect(extractFacilitatorHashFromPaymentResponseHeader(payload)).toBe(TX.toLowerCase());
  });

  it("extracts tx hash from base64url payment-response JSON", () => {
    const payload = Buffer.from(JSON.stringify({ transaction_hash: TX }))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    expect(extractFacilitatorHashFromPaymentResponseHeader(payload)).toBe(TX.toLowerCase());
  });

  it("reads case-insensitive response headers", () => {
    const payload = Buffer.from(JSON.stringify({ transactionHash: TX })).toString("base64");
    const response = new Response("{}", {
      status: 200,
      headers: { "X-Payment-Response": payload },
    });
    expect(extractFacilitatorHashFromResponse(response)).toBe(TX.toLowerCase());
  });

  it("returns null for missing receipt", () => {
    expect(extractFacilitatorHashFromPaymentResponseHeader(null)).toBeNull();
    expect(extractFacilitatorHashFromPaymentResponseHeader("")).toBeNull();
  });

  it("returns null for malformed receipt", () => {
    expect(extractFacilitatorHashFromPaymentResponseHeader("not-valid-base64")).toBeNull();
  });

  it("supports direct JSON payment-response payloads", () => {
    expect(
      extractFacilitatorHashFromPaymentResponseHeader(JSON.stringify({ transactionHash: TX })),
    ).toBe(TX.toLowerCase());
  });
});
