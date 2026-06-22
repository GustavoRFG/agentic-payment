import { describe, expect, it } from "vitest";
import { encodePaymentResponseHeader } from "@x402/core/http";
import {
  extractAndSanitizeFacilitatorReceipt,
  normalizeTransactionHash,
  sanitizeReceiptObject,
} from "../../tools/trustforge/facilitator-settlement-receipt";

const TX = "0x9ce1e957b4547ee86559e8b32af4a9a6e7087f8330096fde618abe4ea9ccf9a9";

describe("facilitator-settlement-receipt", () => {
  it("reads payment-response header via SDK base64 encoding", () => {
    const header = encodePaymentResponseHeader({
      success: true,
      transaction: TX,
      network: "eip155:84532",
      payer: "0xf75d6b83d366a6e9fc2fb8bf113d67050c44f392",
      amount: "1000",
    });
    const response = new Response("{}", { status: 200, headers: { "payment-response": header } });
    const receipt = extractAndSanitizeFacilitatorReceipt(response);
    expect(receipt.parseStatus).toBe("parsed");
    expect(receipt.source).toBe("payment-response-header");
    expect(receipt.transactionHash).toBe(TX.toLowerCase());
    expect(receipt.network).toBe("eip155:84532");
  });

  it("prefers payment-response over x-payment-response", () => {
    const primary = encodePaymentResponseHeader({
      success: true,
      transaction: TX,
      network: "eip155:84532",
    });
    const secondary = encodePaymentResponseHeader({
      success: true,
      transaction: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      network: "eip155:84532",
    });
    const response = new Response("{}", {
      status: 200,
      headers: {
        "payment-response": primary,
        "x-payment-response": secondary,
      },
    });
    expect(extractAndSanitizeFacilitatorReceipt(response).transactionHash).toBe(TX.toLowerCase());
  });

  it("reads x-payment-response when payment-response absent", () => {
    const header = encodePaymentResponseHeader({
      success: true,
      transaction: TX,
      network: "eip155:84532",
    });
    const response = new Response("{}", {
      status: 200,
      headers: { "X-Payment-Response": header },
    });
    const receipt = extractAndSanitizeFacilitatorReceipt(response);
    expect(receipt.source).toBe("x-payment-response-header");
    expect(receipt.transactionHash).toBe(TX.toLowerCase());
  });

  it("returns missing when no receipt header", () => {
    const receipt = extractAndSanitizeFacilitatorReceipt(new Response("{}", { status: 200 }));
    expect(receipt.parseStatus).toBe("missing");
    expect(receipt.transactionHash).toBeNull();
  });

  it("returns malformed for invalid base64 JSON", () => {
    const response = new Response("{}", {
      status: 200,
      headers: { "payment-response": "not-valid-base64!!!" },
    });
    const receipt = extractAndSanitizeFacilitatorReceipt(response);
    expect(receipt.parseStatus).toBe("malformed");
    expect(receipt.parseErrorClass).toBe("INVALID_BASE64_JSON");
  });

  it("returns malformed for JSON without tx field", () => {
    const header = Buffer.from(JSON.stringify({ success: true, network: "eip155:84532" })).toString(
      "base64",
    );
    const receipt = extractAndSanitizeFacilitatorReceipt(
      new Response("{}", { status: 200, headers: { "payment-response": header } }),
    );
    expect(receipt.parseStatus).toBe("malformed");
    expect(receipt.transactionHash).toBeNull();
  });

  it("supports transaction alias fields", () => {
    for (const field of [
      "transactionHash",
      "transaction_hash",
      "txHash",
      "settlementTxHash",
    ] as const) {
      const payload = { [field]: TX, network: "eip155:84532" };
      const receipt = sanitizeReceiptObject(payload, {
        source: "payment-response-header",
        rawHeaderName: "payment-response",
      });
      expect(receipt.transactionHash).toBe(TX.toLowerCase());
    }
  });

  it("normalizes uppercase hash", () => {
    expect(normalizeTransactionHash(TX.toUpperCase())).toBe(TX.toLowerCase());
  });

  it("rejects invalid hashes", () => {
    expect(normalizeTransactionHash("0xabc")).toBeNull();
    expect(normalizeTransactionHash("abc" + "a".repeat(64))).toBeNull();
  });

  it("sanitization excludes forbidden fields", () => {
    const receipt = sanitizeReceiptObject(
      { authorization: "secret", transaction: TX },
      { source: "payment-response-header", rawHeaderName: "payment-response" },
    );
    expect(receipt.parseStatus).toBe("malformed");
    expect(receipt.parseErrorClass).toBe("FORBIDDEN_FIELD");
  });

  it("output JSON string contains no secret keywords", () => {
    const header = encodePaymentResponseHeader({
      success: true,
      transaction: TX,
      network: "eip155:84532",
    });
    const receipt = extractAndSanitizeFacilitatorReceipt(
      new Response("{}", { status: 200, headers: { "payment-response": header } }),
    );
    const serialized = JSON.stringify(receipt).toLowerCase();
    expect(serialized).not.toContain("privatekey");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("authorization");
  });
});
