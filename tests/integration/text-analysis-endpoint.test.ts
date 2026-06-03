import { afterEach, describe, expect, it } from "vitest";

import { TESTNET_NETWORK } from "../../seller-api/src/config/safety";
import type { SellerHarness } from "../../tools/_lib/seller-harness";
import { startTestSeller } from "./_helpers";

describe("text analysis endpoint", () => {
  let seller: SellerHarness | null = null;

  afterEach(async () => {
    await seller?.stop();
    seller = null;
  });

  it("returns HTTP 402 with testnet requirements without payment", async () => {
    seller = await startTestSeller();

    const response = await fetch(`${seller.baseUrl}/paid/analyze-text`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agentic-Request-Id": "test-text-analysis-unpaid",
      },
      body: JSON.stringify({ text: "Analyze this short text.", mode: "summary" }),
    });

    expect(response.status).toBe(402);

    const raw = response.headers.get("payment-required");
    expect(raw).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(raw ?? "", "base64").toString("utf-8"));
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0].network).toBe(TESTNET_NETWORK);
  });

  it("rejects invalid request body before payment is required", async () => {
    seller = await startTestSeller();

    const response = await fetch(`${seller.baseUrl}/paid/analyze-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "summary" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("invalid_request");
    expect(body.missing_fields).toContain("text");
  });
});
