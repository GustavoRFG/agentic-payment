import { afterEach, describe, expect, it } from "vitest";

import { TESTNET_NETWORK } from "../../seller-api/src/config/safety";
import type { SellerHarness } from "../../tools/_lib/seller-harness";
import { startTestSeller } from "./_helpers";

describe("code analysis endpoint", () => {
  let seller: SellerHarness | null = null;

  afterEach(async () => {
    await seller?.stop();
    seller = null;
  });

  it("returns HTTP 402 with testnet requirements without payment", async () => {
    seller = await startTestSeller();

    const response = await fetch(`${seller.baseUrl}/paid/analyze-code`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Agentic-Request-Id": "test-code-analysis-unpaid",
      },
      body: JSON.stringify({ code: "const x = 1;", language: "typescript" }),
    });

    expect(response.status).toBe(402);

    const raw = response.headers.get("payment-required");
    expect(raw).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(raw ?? "", "base64").toString("utf-8"));
    expect(decoded.accepts).toHaveLength(1);
    expect(decoded.accepts[0].network).toBe(TESTNET_NETWORK);
    expect(decoded.accepts[0].amount ?? decoded.accepts[0].maxAmountRequired).toBe(
      "2000",
    );
    expect(decoded.extensions?.bazaar).toBeTruthy();
    expect(decoded.extensions?.discoverable).toBe(true);
  });
});
