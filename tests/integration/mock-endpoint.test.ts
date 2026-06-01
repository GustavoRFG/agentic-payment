import { afterEach, describe, expect, it } from "vitest";

import type { SellerHarness } from "../../tools/_lib/seller-harness";
import { startTestSeller, validRequest } from "./_helpers";

describe("mock endpoint", () => {
  let seller: SellerHarness | null = null;

  afterEach(async () => {
    await seller?.stop();
    seller = null;
  });

  it("serves health and mock reports", async () => {
    seller = await startTestSeller({ adapterMode: "mock" });

    const health = await fetch(`${seller.baseUrl}/health`);
    expect(health.status).toBe(200);

    const report = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRequest()),
    });
    const body = await report.json();

    expect(report.status).toBe(200);
    expect(body.mode).toBe("adapter-mock");
    expect(body.adapter.fallbackUsed).toBe(false);
  });

  it("rejects missing tokenId", async () => {
    seller = await startTestSeller({ adapterMode: "mock" });
    const request = validRequest();
    delete (request.position as Record<string, unknown>).tokenId;

    const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.missing_fields).toContain("position.tokenId");
  });
});
