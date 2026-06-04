import { describe, expect, it } from "vitest";

import {
  MAINNET_NETWORK,
  MAX_PAYMENT_ATTEMPTS,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  SENSITIVE_ENV_NAMES,
  TESTNET_NETWORK,
  activePaymentNetwork,
  isMainnetNetwork,
  isPaymentNetworkAllowed,
  sanitizeEnv,
} from "../../seller-api/src/config/safety";

describe("safety config", () => {
  it("sanitizeEnv removes every sensitive env name", () => {
    const source: NodeJS.ProcessEnv = { BENIGN: "ok" };
    for (const name of SENSITIVE_ENV_NAMES) source[name] = "secret";

    const sanitized = sanitizeEnv(source);

    expect(sanitized.BENIGN).toBe("ok");
    for (const name of SENSITIVE_ENV_NAMES) {
      expect(sanitized[name]).toBeUndefined();
    }
  });

  it("sanitizeEnv preserves benign variables", () => {
    expect(sanitizeEnv({ SAFE_FLAG: "1" })).toEqual({ SAFE_FLAG: "1" });
  });

  it("identifies mainnet networks", () => {
    expect(isMainnetNetwork("eip155:1")).toBe(true);
    expect(isMainnetNetwork("eip155:8453")).toBe(true);
    expect(isMainnetNetwork("eip155:84532")).toBe(false);
  });

  it("defaults the active payment network to testnet", () => {
    expect(activePaymentNetwork({})).toBe(TESTNET_NETWORK);
  });

  it("selects Base mainnet only with explicit opt-in", () => {
    expect(activePaymentNetwork({ X402_USE_MAINNET: "1" })).toBe(
      MAINNET_NETWORK,
    );
    expect(activePaymentNetwork({ X402_USE_MAINNET: "0" })).toBe(
      TESTNET_NETWORK,
    );
  });

  it("allows Base mainnet only when X402_USE_MAINNET is set", () => {
    const previous = process.env.X402_USE_MAINNET;
    try {
      delete process.env.X402_USE_MAINNET;
      expect(isPaymentNetworkAllowed(TESTNET_NETWORK)).toBe(true);
      expect(isPaymentNetworkAllowed(MAINNET_NETWORK)).toBe(false);
      expect(isPaymentNetworkAllowed("eip155:1")).toBe(false);

      process.env.X402_USE_MAINNET = "1";
      expect(isPaymentNetworkAllowed(MAINNET_NETWORK)).toBe(true);
      expect(isPaymentNetworkAllowed("eip155:1")).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.X402_USE_MAINNET;
      else process.env.X402_USE_MAINNET = previous;
    }
  });

  it("keeps payment invariants fixed", () => {
    expect(MAX_PAYMENT_ATTEMPTS).toBe(1);
    expect(PAYMENT_AMOUNT_ATOMIC).toBe("1000");
    expect(PAYMENT_AMOUNT_USD).toBe("0.001");
    expect(PAYMENT_ASSET).toBe("USDC");
  });
});
