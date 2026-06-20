import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  classifyTargetProbeResponse,
  probeTargetLiveness,
  type RecordedProbeResponse,
} from "../../tools/trustforge/target-liveness";
import type { TargetCandidate } from "../../tools/trustforge/target-candidates";

const repoRoot = join(__dirname, "..", "..");

function readFixture(name: string): RecordedProbeResponse {
  const raw = JSON.parse(
    readFileSync(
      join(repoRoot, "trustforge", "fixtures", "bazaar_target_liveness", name),
      "utf8",
    ),
  ) as RecordedProbeResponse;
  return {
    httpStatus: raw.httpStatus,
    headers: raw.headers,
    body: raw.body,
  };
}

function candidate(): TargetCandidate {
  return {
    candidateId: "zapper_tx_explainer",
    resourceUrl: "https://public.zapper.xyz/x402/transaction-details",
    method: "POST",
    x402Version: 2,
    freshness: {
      lastUpdated: "2026-06-15T03:13:41.125Z",
      sortKey: "2026-06-15T03:13:41.125Z",
    },
    registrationMetadata: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              hash: "0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060",
              chainId: 1,
            },
          },
        },
      },
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: MAINNET_USDC_ADDRESS,
        amountAtomic: "1125",
        payTo: "0x43a2a720cd0911690c248075f4a29a5e7716f758",
        maxTimeoutSeconds: 10,
      },
    ],
  };
}

describe("Target liveness handshake probe", () => {
  it("classifies a real recorded Zapper 402 as live_402_ok", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      readFixture("zapper_phase5_live_402.json"),
      { maxTargetPriceAtomic: "10000" },
    );

    expect(outcome.status).toBe("live_402_ok");
    expect(outcome.quoteAtomic).toBe("1125");
    expect(outcome.quoteUsdc).toBe("0.001125");
    expect(outcome.challenge.nonce).toBe("7cbc2c3e-fbcb-4e15-a559-7136ed44b3d2");
    expect(outcome.challenge.expiresAt).toBe("2026-06-15T03:14:15.241Z");
    expect(outcome.walletUsed).toBe(false);
    expect(outcome.paymentAttempted).toBe(false);
  });

  it("classifies the same real 402 as over_budget when the budget is lower", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      readFixture("zapper_phase5_live_402.json"),
      { maxTargetPriceAtomic: "1000" },
    );

    expect(outcome.status).toBe("over_budget");
    expect(outcome.detail).toBe("HTTP 402 quote 1125 exceeds budget 1000");
  });

  it("classifies a real body-only 402 capture without accepts[] as malformed", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      readFixture("mvp_t0_body_only_malformed_402.json"),
      { maxTargetPriceAtomic: "10000" },
    );

    expect(outcome.status).toBe("malformed");
    expect(outcome.detail).toBe("HTTP 402 did not expose parseable accepts[]");
  });

  it("classifies non-402 responses as no_402", () => {
    const outcome = classifyTargetProbeResponse(
      candidate(),
      {
        httpStatus: 200,
        headers: { "content-type": "application/json" },
        body: { ok: true },
      },
      { maxTargetPriceAtomic: "10000" },
    );

    expect(outcome.status).toBe("no_402");
  });

  it("does not send a payment-bearing header during the probe", async () => {
    const fixture = readFixture("zapper_phase5_live_402.json");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      return new Response(JSON.stringify(fixture.body), {
        status: fixture.httpStatus ?? 402,
        headers: fixture.headers,
      });
    }) as unknown as typeof fetch;

    const outcome = await probeTargetLiveness(candidate(), {
      fetchImpl,
      maxTargetPriceAtomic: "10000",
    });

    expect(outcome.status).toBe("live_402_ok");
    expect(outcome.paymentBearingHttpRequestCount).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps Bazaar discovery and probe modules disconnected from wallet and settlement code", () => {
    const guardedFiles = [
      "tools/trustforge/target-liveness.ts",
      "tools/trustforge/target-resolution.ts",
      "tools/run-trustforge-targets-discover.ts",
    ];
    const forbiddenPaidSymbols = [
      "loadRichBuyerWallet",
      "performRichTxExplainerPaidRequest",
      "runRichTxExplainerPhase3",
      "privateKeyToAccount",
      "createWalletClient",
    ];

    for (const file of guardedFiles) {
      const source = readFileSync(join(repoRoot, file), "utf8");
      expect(source).not.toContain("dotenv");
      for (const symbol of forbiddenPaidSymbols) {
        expect(source).not.toContain(symbol);
      }
    }

    const probeSource = readFileSync(
      join(repoRoot, "tools", "trustforge", "target-liveness.ts"),
      "utf8",
    );
    expect(probeSource).not.toContain("BUYER_PRIVATE_KEY");
  });
});
