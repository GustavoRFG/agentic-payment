import { describe, expect, it } from "vitest";

import {
  MAX_PAYMENT_ATTEMPTS,
  PAYMENT_AMOUNT_ATOMIC,
  PAYMENT_AMOUNT_USD,
  PAYMENT_ASSET,
  SENSITIVE_ENV_NAMES,
  isMainnetNetwork,
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

  it("keeps payment invariants fixed", () => {
    expect(MAX_PAYMENT_ATTEMPTS).toBe(1);
    expect(PAYMENT_AMOUNT_ATOMIC).toBe("1000");
    expect(PAYMENT_AMOUNT_USD).toBe("0.001");
    expect(PAYMENT_ASSET).toBe("USDC");
  });
});
