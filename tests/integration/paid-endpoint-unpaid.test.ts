import { afterEach, describe, expect, it } from "vitest";

import {
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_ASSET,
  TESTNET_NETWORK,
} from "../../seller-api/src/config/safety";
import type { SellerHarness } from "../../tools/_lib/seller-harness";
import { startTestSeller, validRequest } from "./_helpers";

describe("paid endpoint without payment", () => {
  let seller: SellerHarness | null = null;

  afterEach(async () => {
    await seller?.stop();
    seller = null;
  });

  it("returns HTTP 402 with testnet USDC requirements", async () => {
    seller = await startTestSeller({ adapterMode: "mock" });
    const response = await fetch(`${seller.baseUrl}/paid/defi-risk-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Agentic-Request-Id": "test-paid-unpaid" },
      body: JSON.stringify(validRequest()),
    });

    expect(response.status).toBe(402);
    expect(response.headers.get("x-agentic-request-id")).toBeTruthy();

    const raw = response.headers.get("payment-required");
    expect(raw).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(raw ?? "", "base64").toString("utf-8"));
    expect(decoded.accepts).toHaveLength(1);
    const accept = decoded.accepts[0];
    expect(accept.network).toBe(TESTNET_NETWORK);
    expect(accept.extra.name).toBe(PAYMENT_ASSET);
    expect(accept.amount ?? accept.maxAmountRequired).toBe(PAYMENT_AMOUNT_ATOMIC);
  });
});
