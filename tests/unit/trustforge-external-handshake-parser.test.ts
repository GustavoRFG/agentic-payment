import { describe, expect, it, vi } from "vitest";

import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  assertExternalPaidExecutionDisabled,
  defaultExternalProbeRunDir,
  inspectExternalX402GetHandshake,
} from "../../tools/trustforge/external-x402-get-adapter";
import { ONESOURCE_ETHEREUM_CHAIN_ID_POLICY } from "../../tools/trustforge/external-x402-get-policy";

const PAY_TO = "0x1111111111111111111111111111111111111111";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    x402Version: 2,
    resource: {
      description: "Ethereum chain id",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "1000",
        asset: MAINNET_USDC_ADDRESS,
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {
          name: "USDC",
          version: "2",
        },
        ...overrides,
      },
    ],
  };
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function responseWithPaymentRequired(
  value: unknown,
  options: { status?: number; body?: string; header?: string } = {},
): Response {
  return new Response(
    options.body ?? JSON.stringify({ error: "payment required", ...value as object }),
    {
      status: options.status ?? 402,
      headers: {
        "content-type": "application/json",
        "payment-required": options.header ?? encoded(value),
      },
    },
  );
}

function fetchOnce(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("TrustForge external x402 handshake parser", () => {
  it("uses the consolidated TrustForge workspace for default dry-run artifacts", () => {
    const runDir = defaultExternalProbeRunDir(
      new Date("2026-06-12T01:02:03.000Z"),
    );

    expect(runDir).toBe(
      "D:\\trustforge\\artifacts\\runs\\mvp-t0a-adapter\\run_20260612_010203",
    );
    expect(runDir).not.toContain("D:\\trustforge-");
  });

  it("fails closed if paid execution is accidentally enabled", () => {
    const original = process.env.TRUSTFORGE_EXTERNAL_PAID_ENABLE;
    process.env.TRUSTFORGE_EXTERNAL_PAID_ENABLE = "1";
    try {
      expect(() => assertExternalPaidExecutionDisabled()).toThrow(
        "external paid execution is disabled",
      );
    } finally {
      if (original === undefined) {
        delete process.env.TRUSTFORGE_EXTERNAL_PAID_ENABLE;
      } else {
        process.env.TRUSTFORGE_EXTERNAL_PAID_ENABLE = original;
      }
    }
  });

  it("parses a valid x402 v2 handshake", async () => {
    const inspection = await inspectExternalX402GetHandshake(
      ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
      { fetchImpl: fetchOnce(responseWithPaymentRequired(envelope())) },
    );

    expect(inspection.httpStatus).toBe(402);
    expect(inspection.x402VersionObserved).toBe("2");
    expect(inspection.network).toBe("eip155:8453");
    expect(inspection.asset).toBe("USDC");
    expect(inspection.quoteUsdc).toBe("0.001");
    expect(inspection.payTo).toBe(PAY_TO);
    expect(inspection.paymentAttempted).toBe(false);
  });

  it("accepts quote 0.001 USDC", async () => {
    const inspection = await inspectExternalX402GetHandshake(
      ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
      { fetchImpl: fetchOnce(responseWithPaymentRequired(envelope({ amount: "1000" }))) },
    );

    expect(inspection.quoteUsdc).toBe("0.001");
  });

  it("accepts quote exactly 0.005 USDC", async () => {
    const inspection = await inspectExternalX402GetHandshake(
      ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
      { fetchImpl: fetchOnce(responseWithPaymentRequired(envelope({ amount: "5000" }))) },
    );

    expect(inspection.quoteUsdc).toBe("0.005");
  });

  it("rejects quote 0.005001 USDC", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(responseWithPaymentRequired(envelope({ amount: "5001" }))),
      }),
    ).rejects.toThrow("exceeds policy");
  });

  it("rejects a different network", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(
          responseWithPaymentRequired(envelope({ network: "eip155:84532" })),
        ),
      }),
    ).rejects.toThrow("network");
  });

  it("rejects a different token", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(
          responseWithPaymentRequired(
            envelope({
              asset: "0x0000000000000000000000000000000000000000",
              extra: { name: "DAI" },
            }),
          ),
        ),
      }),
    ).rejects.toThrow("asset");
  });

  it("rejects missing payTo", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(responseWithPaymentRequired(envelope({ payTo: undefined }))),
      }),
    ).rejects.toThrow("payTo");
  });

  it("rejects HTTP 200 as an unexpected handshake", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(responseWithPaymentRequired(envelope(), { status: 200 })),
      }),
    ).rejects.toThrow("expected HTTP 402");
  });

  it("rejects HTTP 404", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(responseWithPaymentRequired(envelope(), { status: 404 })),
      }),
    ).rejects.toThrow("expected HTTP 402");
  });

  it("rejects redirect responses", async () => {
    const response = new Response("", {
      status: 302,
      headers: { location: "https://api.onesource.io/other" },
    });

    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(response),
      }),
    ).rejects.toThrow("redirect");
  });

  it("rejects invalid response body JSON", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(
          responseWithPaymentRequired(envelope(), { body: "{" }),
        ),
      }),
    ).rejects.toThrow("invalid 402 response body JSON");
  });

  it("rejects invalid PAYMENT-REQUIRED header", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(
          responseWithPaymentRequired(envelope(), { header: "not-base64-json" }),
        ),
      }),
    ).rejects.toThrow("invalid PAYMENT-REQUIRED header");
  });

  it("rejects missing payment requirements", async () => {
    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl: fetchOnce(
          new Response(JSON.stringify({ error: "payment required" }), {
            status: 402,
            headers: { "content-type": "application/json" },
          }),
        ),
      }),
    ).rejects.toThrow("did not expose x402 payment requirements");
  });
});
