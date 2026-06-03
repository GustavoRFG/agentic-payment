import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  PAYMENT_AMOUNT_USD,
  TESTNET_NETWORK,
  sanitizeEnv,
} from "../../seller-api/src/config/safety";
import { runCommand } from "../../tools/_lib/child-process";
import type { SellerHarness } from "../../tools/_lib/seller-harness";
import { projectRoot, startTestSeller } from "./_helpers";

describe("buyer dry-run", () => {
  let seller: SellerHarness | null = null;

  afterEach(async () => {
    await seller?.stop();
    seller = null;
  });

  it("discovers text-analysis payment requirements without signing or paying", async () => {
    seller = await startTestSeller();

    const result = await runCommand(
      "buyer dry-run",
      join(projectRoot(), "buyer-client"),
      ["run", "dev", "--", "--dry-run"],
      {
        ...sanitizeEnv(),
        AGENTIC_SKIP_DOTENV: "1",
        SELLER_BASE_URL: seller.baseUrl,
        MAX_PAYMENT_USD: PAYMENT_AMOUNT_USD,
        X402_NETWORK: TESTNET_NETWORK,
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;

    expect(output).toContain("received HTTP 402");
    expect(output).toContain("payment requirements");
    expect(output).toContain(TESTNET_NETWORK);
    expect(output).toContain("dry-run OK");
    expect(output).not.toContain("--pay");
    expect(output.toLowerCase()).not.toContain("signing");
    expect(output).not.toContain("payment-bearing HTTP requests");
  });
});
