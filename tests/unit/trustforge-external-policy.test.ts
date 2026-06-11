import { describe, expect, it } from "vitest";

import {
  ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
  requestFromPolicy,
  resolveExternalX402GetProbePolicy,
  validateExternalProbeRequest,
  type ExternalX402GetProbeRequest,
} from "../../tools/trustforge/external-x402-get-policy";

function request(
  overrides: Partial<ExternalX402GetProbeRequest> = {},
): ExternalX402GetProbeRequest {
  return {
    ...requestFromPolicy(ONESOURCE_ETHEREUM_CHAIN_ID_POLICY),
    ...overrides,
  };
}

describe("TrustForge external x402 GET policy", () => {
  it("accepts the official exact policy request", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request(),
      ),
    ).not.toThrow();
  });

  it("rejects an alternate host", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ url: "https://evil.example/api/chain/chain-id?network=ethereum" }),
      ),
    ).toThrow();
  });

  it("rejects HTTP without TLS", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ url: "http://api.onesource.io/api/chain/chain-id?network=ethereum" }),
      ),
    ).toThrow();
  });

  it("rejects an alternate path", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ url: "https://api.onesource.io/api/chain/block-number?network=ethereum" }),
      ),
    ).toThrow();
  });

  it("rejects a removed query", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ url: "https://api.onesource.io/api/chain/chain-id" }),
      ),
    ).toThrow();
  });

  it("rejects an added query parameter", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({
          url: "https://api.onesource.io/api/chain/chain-id?network=ethereum&extra=1",
        }),
      ),
    ).toThrow();
  });

  it("rejects POST", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ method: "POST" }),
      ),
    ).toThrow();
  });

  it("rejects redirects", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ allowRedirects: true }),
      ),
    ).toThrow();
  });

  it("rejects retry", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ allowRetries: true }),
      ),
    ).toThrow();
  });

  it("rejects fallback", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ allowFallback: true }),
      ),
    ).toThrow();
  });

  it("rejects batch execution", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ batch: true }),
      ),
    ).toThrow();
  });

  it("rejects loop execution", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ loop: true }),
      ),
    ).toThrow();
  });

  it("rejects scheduler execution", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ scheduler: true }),
      ),
    ).toThrow();
  });

  it("rejects maxPaymentAttempts > 1", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ maxPaymentAttempts: 2 }),
      ),
    ).toThrow();
  });

  it("rejects a different network", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ allowedNetwork: "eip155:84532" }),
      ),
    ).toThrow();
  });

  it("rejects a different asset", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ allowedAsset: "ETH" }),
      ),
    ).toThrow();
  });

  it("rejects a cap above 0.005 USDC", () => {
    expect(() =>
      validateExternalProbeRequest(
        ONESOURCE_ETHEREUM_CHAIN_ID_POLICY,
        request({ maxPricePerCallUsdc: "0.005001" }),
      ),
    ).toThrow();
  });

  it("rejects an unknown policy", () => {
    expect(() =>
      resolveExternalX402GetProbePolicy("unknown_external_policy"),
    ).toThrow("unknown external probe policy");
  });
});
