import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  inspectExternalX402GetHandshake,
  writeExternalProbePreflightArtifacts,
} from "../../tools/trustforge/external-x402-get-adapter";
import { ONESOURCE_ETHEREUM_CHAIN_ID_POLICY } from "../../tools/trustforge/external-x402-get-policy";

const PAY_TO = "0x2222222222222222222222222222222222222222";

function envelope() {
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
      },
    ],
  };
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function validResponse(): Response {
  const body = {
    ...envelope(),
    signature: "SECRET_SIGNATURE_SHOULD_BE_REDACTED",
  };
  return new Response(JSON.stringify(body), {
    status: 402,
    headers: {
      "content-type": "application/json",
      "payment-required": encoded(envelope()),
    },
  });
}

describe("TrustForge external x402 GET dry-run integration", () => {
  const originalPrivateKey = process.env.BUYER_PRIVATE_KEY;

  afterEach(() => {
    if (originalPrivateKey === undefined) {
      delete process.env.BUYER_PRIVATE_KEY;
    } else {
      process.env.BUYER_PRIVATE_KEY = originalPrivateKey;
    }
    vi.restoreAllMocks();
  });

  it("inspects a valid 402 handshake with one unpaid GET and writes sanitized scratch artifacts", async () => {
    process.env.BUYER_PRIVATE_KEY = "SENTINEL_SHOULD_NOT_BE_USED";
    const fetchImpl = vi.fn(async (_input, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(containsX402PaymentHeader(init?.headers)).toBe(false);
      return validResponse();
    }) as unknown as typeof fetch;

    const inspection = await inspectExternalX402GetHandshake(
      ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
      { fetchImpl },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(inspection.httpStatus).toBe(402);
    expect(inspection.quoteUsdc).toBe("0.001");
    expect(inspection.paymentAttempted).toBe(false);
    expect(inspection.walletUsed).toBe(false);

    const runDir = mkdtempSync(join(tmpdir(), "trustforge-external-dry-run-"));
    await writeExternalProbePreflightArtifacts(
      runDir,
      ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
      inspection,
    );

    expect(resolve(runDir).startsWith(resolve(process.cwd()))).toBe(false);
    for (const file of [
      "00_execution_log.md",
      "01_policy.json",
      "02_request_summary_sanitized.json",
      "03_unpaid_response_status.txt",
      "04_unpaid_response_headers_sanitized.txt",
      "05_unpaid_response_body_sanitized.json",
      "06_handshake_inspection.json",
      "07_preflight_report.md",
      "RESULT.txt",
    ]) {
      expect(existsSync(join(runDir, file))).toBe(true);
    }
    const bodyArtifact = readFileSync(
      join(runDir, "05_unpaid_response_body_sanitized.json"),
      "utf8",
    );
    expect(bodyArtifact).not.toContain("SECRET_SIGNATURE_SHOULD_BE_REDACTED");
    expect(bodyArtifact).toContain("[REDACTED]");
  });

  it("rejects a redirect without retrying", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://api.onesource.io/other" },
      }),
    ) as unknown as typeof fetch;

    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl,
      }),
    ).rejects.toThrow("redirect");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records timeout as a failed single request", async () => {
    const fetchImpl = vi.fn((_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }) as unknown as typeof fetch;

    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl,
        timeoutMs: 1,
      }),
    ).rejects.toThrow("aborted");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("records network errors without retrying", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    await expect(
      inspectExternalX402GetHandshake(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY, {
        fetchImpl,
      }),
    ).rejects.toThrow("network down");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
