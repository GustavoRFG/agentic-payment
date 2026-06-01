import { afterEach, describe, expect, it } from "vitest";

import { forbiddenSnapshotPath } from "../../seller-api/src/domain/defiGuardianSnapshotV1";
import type { SellerHarness } from "../../tools/_lib/seller-harness";
import {
  fixtureSnapshotPath,
  startTestSeller,
  validRequest,
  ZERO_ADDRESS,
} from "./_helpers";

describe("real-file adapter", () => {
  let seller: SellerHarness | null = null;

  afterEach(async () => {
    await seller?.stop();
    seller = null;
  });

  it("serves a known token from the committed fixture", async () => {
    seller = await startTestSeller({ adapterMode: "real-file", snapshotPath: fixtureSnapshotPath() });
    const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: ZERO_ADDRESS,
        position: { protocol: "pancakeswap-v3", chain: "bsc", tokenId: "demo-real-file-001" },
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("adapter-real-file");
    expect(body.adapter.resolvedMode).toBe("adapter-real-file");
    expect(body.adapter.fallbackUsed).toBe(false);
  });

  it("falls back honestly for unknown token ids", async () => {
    seller = await startTestSeller({ adapterMode: "real-file", snapshotPath: fixtureSnapshotPath() });
    const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRequest("missing-token")),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.mode).toBe("adapter-mock");
    expect(body.adapter.requestedMode).toBe("adapter-real-file");
    expect(body.adapter.resolvedMode).toBe("adapter-mock");
    expect(body.adapter.fallbackUsed).toBe(true);
  });

  it("falls back for missing snapshot files", async () => {
    seller = await startTestSeller({ adapterMode: "real-file", snapshotPath: "D:\\missing\\snapshot.json" });
    const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRequest()),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.adapter.fallbackUsed).toBe(true);
  });

  it("rejects forbidden snapshot paths before reading", async () => {
    expect(forbiddenSnapshotPath("secrets/cdp.env")).not.toBeNull();

    seller = await startTestSeller({ adapterMode: "real-file", snapshotPath: "secrets/cdp.env" });
    const response = await fetch(`${seller.baseUrl}/mock/defi-risk-report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validRequest()),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.adapter.fallbackUsed).toBe(true);
  });
});
