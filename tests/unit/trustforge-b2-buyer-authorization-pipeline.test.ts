/**
 * B.2 buyer authorization pipeline — offline, injected signer, no send.
 *
 * Every signer here is a fixture that returns a fixed 65-byte hex string. No
 * fixture holds a real or operational key, nothing reads a wallet env var, and
 * nothing performs network I/O.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BLOCKED_BUYER_ATTEMPT_DUPLICATE,
  BLOCKED_BUYER_NONCE_INVALID,
  BLOCKED_BUYER_NONCE_REUSED,
  BUYER_NONCE_BYTE_LENGTH,
  BuyerAttemptRegistry,
  assertCanonicalBuyerNonce,
  cryptoBuyerNonceSource,
  redactNonce,
  runBuyerAuthorizationPipeline,
} from "../../tools/trustforge/buyer-authorization-attempt";
import {
  BLOCKED_BUYER_EIP3009_DOMAIN_UNRESOLVED,
  BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH,
  BLOCKED_HUMAN_AUTHORIZATION_EXPIRED,
  BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH,
  EIP3009_AUTHORIZATION_TYPES,
  EIP3009_PRIMARY_TYPE,
  buildBuyerValidity,
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
  resolveEip3009Domain,
  signUnsignedAuthorization,
  type InjectedTypedDataSigner,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import {
  BLOCKED_BUYER_ARTIFACT_ORDER,
  BLOCKED_BUYER_ARTIFACT_OVERWRITE,
  SIGNED_ARTIFACT,
  UNSIGNED_ARTIFACT,
  writeArtifactOnce,
} from "../../tools/trustforge/buyer-authorization-artifacts";
import {
  B2_FORBIDDEN_STATES,
  BLOCKED_BUYER_AUTHORIZATION_ILLEGAL_TRANSITION,
  BLOCKED_BUYER_AUTHORIZATION_RESUME_FORBIDDEN,
  BLOCKED_BUYER_AUTHORIZATION_SEND_NOT_IMPLEMENTED,
  assertLegalTransition,
  assertNotResumableForSend,
  assertReachableInB2,
  isTerminalState,
  legalNextStates,
  terminalStateForUnsentAttempt,
} from "../../tools/trustforge/buyer-authorization-state-machine";
import {
  BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS,
  SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS,
  type SellerRequirementsObservation,
} from "../../tools/trustforge/x402-seller-requirements-binding";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";

// ---------------------------------------------------------------- fixtures
const BUYER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SIGNATURE = `0x${"ab".repeat(65)}`;
const NONCE_A = `0x${"11".repeat(32)}`;
const NONCE_B = `0x${"22".repeat(32)}`;

const OBSERVED_AT = "2026-01-01T00:00:00.000Z";
const SIGNING_TIME = new Date("2026-01-01T00:01:00.000Z");

/** A fixture signer. Holds no key material of any kind. */
function fixtureSigner(address = BUYER): InjectedTypedDataSigner & { calls: number } {
  const signer = {
    address,
    calls: 0,
    async signTypedData() {
      signer.calls += 1;
      return SIGNATURE;
    },
  };
  return signer;
}

function observation(overrides: {
  readonly protocolVersion?: 1 | 2;
  readonly sellerNetworkRaw?: string;
  readonly canonicalCaip2?: "eip155:8453" | "eip155:84532";
  readonly amount?: string;
  readonly extra?: unknown;
  readonly observedAt?: string;
  readonly maxTimeoutSeconds?: number;
  readonly asset?: string;
  readonly payTo?: string;
  readonly requirementsSha?: string;
  readonly envelopeSha?: string;
  readonly requestBindingSha?: string;
} = {}): SellerRequirementsObservation {
  return {
    requirements_observed_at: overrides.observedAt ?? OBSERVED_AT,
    selected_requirements: {},
    payment_required_envelope: {},
    ancillary_tempo_evidence: null,
    binding: {
      protocol_version: overrides.protocolVersion ?? 1,
      transport: "payment-required-header",
      scheme: "exact",
      seller_network_raw: overrides.sellerNetworkRaw ?? "base",
      canonical_network_caip2: overrides.canonicalCaip2 ?? "eip155:8453",
      asset: overrides.asset ?? ASSET,
      amount_field: "maxAmountRequired",
      amount_atomic: overrides.amount ?? "1000",
      pay_to: overrides.payTo ?? PAY_TO,
      max_timeout_seconds: overrides.maxTimeoutSeconds ?? 600,
      resource: null,
      // "extra" in overrides distinguishes "not overridden" from "explicitly
      // absent", which is exactly the case the domain resolver must refuse
      extra: "extra" in overrides ? overrides.extra : { name: "USD Coin", version: "2" },
      request_binding_sha256: overrides.requestBindingSha ?? "rb-sha",
      canonical_requirements_sha256: overrides.requirementsSha ?? "req-sha",
      canonical_envelope_sha256: overrides.envelopeSha ?? "env-sha",
    },
  };
}

function humanAuthorization(
  overrides: Partial<HumanPaymentAuthorization> = {},
): HumanPaymentAuthorization {
  return {
    authorization_schema_version: "v3",
    decision: "approve",
    provider: "fixture",
    service_id: "svc",
    endpoint: "https://seller.example/api",
    method: "POST",
    canonical_requirements_sha256: "req-sha",
    canonical_envelope_sha256: "env-sha",
    request_binding_sha256: "rb-sha",
    seller_network_raw: "base",
    canonical_network_caip2: "eip155:8453",
    asset: ASSET,
    pay_to: PAY_TO,
    amount_atomic: "1000",
    maximum_authorized_amount_atomic: "2000",
    buyer_wallet: BUYER,
    max_usdc: "0.002",
    max_payment_attempts: 1,
    allow_retry: false,
    authorization_expires_at: "2026-01-01T00:10:00.000Z",
    ...overrides,
  };
}

function prepared(overrides: {
  readonly obs?: SellerRequirementsObservation;
  readonly human?: HumanPaymentAuthorization;
  readonly signingTime?: Date;
  readonly buyer?: string;
} = {}) {
  return {
    humanAuthorization: overrides.human ?? humanAuthorization(),
    paytimeObservation: overrides.obs ?? observation(),
    authorizedRequirementsSha256: "req-sha",
    authorizedEnvelopeSha256: "env-sha",
    authorizedRequestBindingSha256: "rb-sha",
    authorizedEndpoint: "https://seller.example/api",
    authorizedMethod: "POST",
    buyerAddress: overrides.buyer ?? BUYER,
    signingTime: overrides.signingTime ?? SIGNING_TIME,
  };
}

const temporaryDirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b2-attempt-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- blocker
describe("production blocker stays closed", () => {
  it("the pre-B.2 blocker still throws and has no environment escape", async () => {
    const module = await import("../../tools/trustforge/pre-b2-paid-execution-blocker");
    expect(() => module.assertB2BuyerSignedAuthorizationPipelineImplemented()).toThrow(
      /BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED/,
    );
    const source = readFileSync(
      "tools/trustforge/pre-b2-paid-execution-blocker.ts",
      "utf8",
    );
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/argv/);
  });

  it("no productive runner imports the B.2 pipeline", () => {
    const productive = [
      "tools/trustforge/x402-paid-settlement-runner.ts",
      "tools/trustforge/x402-thin-settlement-executor.ts",
      "tools/trustforge/x402-single-settlement-executor.ts",
      "tools/trustforge/external-x402-paid-executor.ts",
    ];
    for (const file of productive) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/buyer-authorization-attempt/);
      expect(source).not.toMatch(/buyer-eip3009-authorization/);
      expect(source).not.toMatch(/runBuyerAuthorizationPipeline/);
    }
  });
});

// ---------------------------------------------------------------- domain
describe("EIP-3009 domain", () => {
  it("mirrors the installed @x402/evm construction", () => {
    const { domain, provenance } = resolveEip3009Domain({
      observation: observation(),
      authorizedAsset: ASSET,
    });
    expect(domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: ASSET,
    });
    expect(provenance.fallback_used).toBe(false);
    expect(EIP3009_PRIMARY_TYPE).toBe("TransferWithAuthorization");
    expect(EIP3009_AUTHORIZATION_TYPES.TransferWithAuthorization.map((f) => f.name)).toEqual([
      "from",
      "to",
      "value",
      "validAfter",
      "validBefore",
      "nonce",
    ]);
  });

  it("derives chain id from the canonical network, per version", () => {
    expect(
      resolveEip3009Domain({
        observation: observation({ sellerNetworkRaw: "base-sepolia", canonicalCaip2: "eip155:84532" }),
        authorizedAsset: ASSET,
      }).domain.chainId,
    ).toBe(84532);
    expect(
      resolveEip3009Domain({
        observation: observation({
          protocolVersion: 2,
          sellerNetworkRaw: "eip155:8453",
          canonicalCaip2: "eip155:8453",
        }),
        authorizedAsset: ASSET,
      }).domain.chainId,
    ).toBe(8453);
  });

  it("refuses to guess a missing name or version", () => {
    for (const extra of [undefined, null, {}, { name: "USD Coin" }, { version: "2" }]) {
      expect(() =>
        resolveEip3009Domain({ observation: observation({ extra }), authorizedAsset: ASSET }),
      ).toThrow(new RegExp(BLOCKED_BUYER_EIP3009_DOMAIN_UNRESOLVED));
    }
  });

  it("refuses an asset that is not the authorized one", () => {
    expect(() =>
      resolveEip3009Domain({
        observation: observation(),
        authorizedAsset: "0x3333333333333333333333333333333333333333",
      }),
    ).toThrow(new RegExp(BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH));
  });

  it("rejects a raw/canonical network mismatch", () => {
    expect(() =>
      resolveEip3009Domain({
        observation: observation({ sellerNetworkRaw: "base", canonicalCaip2: "eip155:84532" }),
        authorizedAsset: ASSET,
      }),
    ).toThrow(/REJECTED_X402_NETWORK_IDENTITY_UNSUPPORTED/);
  });
});

// ---------------------------------------------------------------- preparation
describe("fresh authorized requirements binding", () => {
  it("accepts v1 base, v1 base-sepolia and v2 base", () => {
    const cases = [
      { protocolVersion: 1 as const, sellerNetworkRaw: "base", canonicalCaip2: "eip155:8453" as const },
      { protocolVersion: 1 as const, sellerNetworkRaw: "base-sepolia", canonicalCaip2: "eip155:84532" as const },
      { protocolVersion: 2 as const, sellerNetworkRaw: "eip155:8453", canonicalCaip2: "eip155:8453" as const },
    ];
    for (const c of cases) {
      const unsigned = buildUnsignedBuyerAuthorization({
        ...prepared({
          obs: observation(c),
          human: humanAuthorization({
            seller_network_raw: c.sellerNetworkRaw,
            canonical_network_caip2: c.canonicalCaip2,
          }),
        }),
        nonce: NONCE_A,
      });
      expect(unsigned.message.value).toBe("1000");
      expect(unsigned.message.from).toBe(BUYER);
      expect(unsigned.message.to).toBe(PAY_TO);
    }
  });

  it("value is the seller amount, never the authorized maximum", () => {
    const unsigned = buildUnsignedBuyerAuthorization({ ...prepared(), nonce: NONCE_A });
    expect(unsigned.message.value).toBe("1000");
    expect(unsigned.maximum_authorized_amount_atomic).toBe("2000");
    expect(unsigned.message.value).not.toBe(unsigned.maximum_authorized_amount_atomic);
  });

  it.each([
    ["requirements hash", { requirementsSha: "other" }],
    ["envelope hash", { envelopeSha: "other" }],
    ["request binding", { requestBindingSha: "other" }],
    ["asset", { asset: "0x4444444444444444444444444444444444444444" }],
    ["payTo", { payTo: "0x5555555555555555555555555555555555555555" }],
  ])("blocks on %s mismatch", (_label, override) => {
    expect(() =>
      buildUnsignedBuyerAuthorization({
        ...prepared({ obs: observation(override) }),
        nonce: NONCE_A,
      }),
    ).toThrow(/BLOCKED_(PRE_PAYMENT_402_INTENT_MISMATCH|PAYMENT_REQUIREMENTS_HASH_MISMATCH)/);
  });

  it("blocks a seller amount above the authorized maximum", () => {
    expect(() =>
      buildUnsignedBuyerAuthorization({
        ...prepared({ obs: observation({ amount: "5000" }) }),
        nonce: NONCE_A,
      }),
    ).toThrow(/exceeds the maximum authorized/);
  });

  it.each([
    ["endpoint", { endpoint: "https://other.example/api" }],
    ["method", { method: "GET" }],
  ])("blocks on %s mismatch", (_label, override) => {
    expect(() =>
      buildUnsignedBuyerAuthorization({
        ...prepared({ human: humanAuthorization(override) }),
        nonce: NONCE_A,
      }),
    ).toThrow(new RegExp(BLOCKED_PRE_PAYMENT_402_INTENT_MISMATCH));
  });

  it("blocks an expired human authorization", () => {
    expect(() =>
      buildUnsignedBuyerAuthorization({
        ...prepared({
          human: humanAuthorization({ authorization_expires_at: "2026-01-01T00:00:30.000Z" }),
        }),
        nonce: NONCE_A,
      }),
    ).toThrow(new RegExp(BLOCKED_HUMAN_AUTHORIZATION_EXPIRED));
  });

  it("blocks a stale observation past the effective deadline", () => {
    expect(() =>
      buildUnsignedBuyerAuthorization({
        ...prepared({ signingTime: new Date("2026-01-01T00:09:00.000Z") }),
        nonce: NONCE_A,
      }),
    ).toThrow(/BLOCKED_PAYMENT_REQUIREMENTS_STALE/);
  });
});

// ---------------------------------------------------------------- temporal
describe("temporal validity", () => {
  it("backdates validAfter by the approved skew", () => {
    const validity = buildBuyerValidity({
      signingTime: SIGNING_TIME,
      effectiveSigningDeadline: "2026-01-01T00:05:00.000Z",
    });
    const signingSeconds = Math.floor(SIGNING_TIME.getTime() / 1000);
    expect(Number(validity.validAfter)).toBe(signingSeconds - BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS);
    expect(BUYER_VALID_AFTER_CLOCK_SKEW_SECONDS).toBe(60);
    expect(Number(validity.validAfter)).toBeLessThan(signingSeconds);
    expect(Number(validity.validBefore)).toBeGreaterThan(signingSeconds);
  });

  it("validBefore never exceeds the effective deadline", () => {
    const deadline = "2026-01-01T00:05:00.000Z";
    const validity = buildBuyerValidity({ signingTime: SIGNING_TIME, effectiveSigningDeadline: deadline });
    expect(Number(validity.validBefore)).toBe(Math.floor(Date.parse(deadline) / 1000));
  });

  it("the seller timeout wins when it is the smallest", () => {
    const unsigned = buildUnsignedBuyerAuthorization({
      ...prepared({ obs: observation({ maxTimeoutSeconds: 120 }) }),
      nonce: NONCE_A,
    });
    expect(unsigned.effective_signing_deadline).toBe("2026-01-01T00:02:00.000Z");
  });

  it("the 300 second local cap wins over a longer seller timeout", () => {
    const unsigned = buildUnsignedBuyerAuthorization({
      ...prepared({ obs: observation({ maxTimeoutSeconds: 1200 }) }),
      nonce: NONCE_A,
    });
    expect(SELLER_REQUIREMENTS_LOCAL_FRESHNESS_CAP_SECONDS).toBe(300);
    expect(unsigned.effective_signing_deadline).toBe("2026-01-01T00:05:00.000Z");
  });

  it("the human expiry wins when it is the smallest", () => {
    const unsigned = buildUnsignedBuyerAuthorization({
      ...prepared({
        obs: observation({ maxTimeoutSeconds: 1200 }),
        human: humanAuthorization({ authorization_expires_at: "2026-01-01T00:03:00.000Z" }),
      }),
      nonce: NONCE_A,
    });
    expect(unsigned.effective_signing_deadline).toBe("2026-01-01T00:03:00.000Z");
  });

  it("refuses a validBefore that is not in the future", () => {
    expect(() =>
      buildBuyerValidity({
        signingTime: SIGNING_TIME,
        effectiveSigningDeadline: "2026-01-01T00:00:30.000Z",
      }),
    ).toThrow(/BLOCKED_BUYER_AUTHORIZATION_VALIDITY_INVALID/);
  });
});

// ---------------------------------------------------------------- nonce
describe("buyer nonce", () => {
  it("is 32 bytes of canonical lowercase hex", () => {
    expect(BUYER_NONCE_BYTE_LENGTH).toBe(32);
    const nonce = cryptoBuyerNonceSource();
    expect(nonce).toMatch(/^0x[0-9a-f]{64}$/);
    expect(Buffer.from(nonce.slice(2), "hex")).toHaveLength(32);
  });

  it("rejects anything that is not canonical", () => {
    for (const bad of ["0x1234", `0X${"11".repeat(32)}`, `0x${"AB".repeat(32)}`, "", "not-hex"]) {
      expect(() => assertCanonicalBuyerNonce(bad)).toThrow(new RegExp(BLOCKED_BUYER_NONCE_INVALID));
    }
  });

  it("is not a uuid, a timestamp, a counter or the seller's id", () => {
    const source = readFileSync("tools/trustforge/buyer-authorization-attempt.ts", "utf8");
    expect(source).toMatch(/randomBytes\(BUYER_NONCE_BYTE_LENGTH\)/);
    expect(source).not.toMatch(/randomUUID/);
    expect(source).not.toMatch(/Date\.now\(\)\s*\.toString/);
    const nonces = new Set(Array.from({ length: 200 }, () => cryptoBuyerNonceSource()));
    expect(nonces.size).toBe(200);
  });

  it("belongs to exactly one attempt and is never reused", () => {
    const registry = new BuyerAttemptRegistry(2);
    const first = registry.reserve({
      attemptId: "a1", runId: "r", nonceSource: () => NONCE_A, now: SIGNING_TIME,
    });
    expect(first.nonce).toBe(NONCE_A);
    expect(registry.nonceFor("a1")).toBe(NONCE_A);
    expect(() =>
      registry.reserve({ attemptId: "a2", runId: "r", nonceSource: () => NONCE_A, now: SIGNING_TIME }),
    ).toThrow(new RegExp(BLOCKED_BUYER_NONCE_REUSED));
  });

  it("keeps an abandoned attempt's nonce consumed", () => {
    const registry = new BuyerAttemptRegistry(3);
    registry.reserve({ attemptId: "a1", runId: "r", nonceSource: () => NONCE_A, now: SIGNING_TIME });
    registry.abandon("a1");
    expect(registry.hasConsumedNonce(NONCE_A)).toBe(true);
    expect(() =>
      registry.reserve({ attemptId: "a2", runId: "r", nonceSource: () => NONCE_A, now: SIGNING_TIME }),
    ).toThrow(new RegExp(BLOCKED_BUYER_NONCE_REUSED));
  });

  it("blocks a duplicate attempt id", () => {
    const registry = new BuyerAttemptRegistry(2);
    registry.reserve({ attemptId: "a1", runId: "r", nonceSource: () => NONCE_A, now: SIGNING_TIME });
    expect(() =>
      registry.reserve({ attemptId: "a1", runId: "r", nonceSource: () => NONCE_B, now: SIGNING_TIME }),
    ).toThrow(new RegExp(BLOCKED_BUYER_ATTEMPT_DUPLICATE));
  });

  it("never appears whole in a redacted log line", () => {
    expect(redactNonce(NONCE_A)).not.toContain(NONCE_A.slice(2, 20));
    expect(redactNonce(NONCE_A)).toMatch(/^0x…[0-9a-f]{4}$/);
  });

  it("is not drawn when the binding mismatches", async () => {
    expect(() =>
      buildUnsignedBuyerAuthorization({
        ...prepared({ obs: observation({ requirementsSha: "other" }) }),
        nonce: NONCE_A,
      }),
    ).toThrow(/HASH_MISMATCH/);
    // the pipeline validates before reserving, so a mismatching run never spends one
    const dir = workDir();
    const registry = new BuyerAttemptRegistry(1);
    const guardedSource = vi.fn(() => NONCE_B);
    await expect(
      runBuyerAuthorizationPipeline({
        directory: dir,
        runId: "run",
        attemptId: "attempt",
        commitSha: null,
        registry,
        nonceSource: guardedSource,
        signer: fixtureSigner(),
        now: SIGNING_TIME,
        prepared: prepared({ obs: observation({ requirementsSha: "other" }) }),
      }),
    ).rejects.toThrow(/HASH_MISMATCH/);
    expect(guardedSource).not.toHaveBeenCalled();
    expect(registry.attemptCount).toBe(0);
    expect(registry.hasConsumedNonce(NONCE_B)).toBe(false);
  });
});

// ---------------------------------------------------------------- persistence
describe("write-once artifacts and ordering", () => {
  it("persists unsigned before the signer is ever called", async () => {
    const dir = workDir();
    const signer = fixtureSigner();
    const order: string[] = [];
    const wrapped: InjectedTypedDataSigner = {
      address: signer.address,
      async signTypedData(args) {
        order.push(existsSync(join(dir, UNSIGNED_ARTIFACT)) ? "unsigned-exists" : "unsigned-missing");
        return signer.signTypedData(args);
      },
    };
    const result = await runBuyerAuthorizationPipeline({
      directory: dir,
      runId: "run",
      attemptId: "attempt",
      commitSha: "deadbee",
      registry: new BuyerAttemptRegistry(1),
      nonceSource: () => NONCE_A,
      signer: wrapped,
      now: SIGNING_TIME,
      prepared: prepared(),
    });
    expect(order).toEqual(["unsigned-exists"]);
    expect(result.signed_state_reached).toBe("SIGNED_PERSISTED");
    expect(result.state).toBe("TERMINAL_ABANDONED_REAUTHORIZE");
    expect(result.sent).toBe(false);
    expect(result.resumable_for_send).toBe(false);
    expect(result.payment_bearing_request_count).toBe(0);
    expect(existsSync(join(dir, SIGNED_ARTIFACT))).toBe(true);
    expect(existsSync(join(dir, "buyer_authorization_abandoned.json"))).toBe(true);
  });

  it("does not call the signer when the unsigned write fails", async () => {
    const dir = workDir();
    const signer = fixtureSigner();
    writeArtifactOnce(join(dir, UNSIGNED_ARTIFACT), { squatter: true });
    await expect(
      runBuyerAuthorizationPipeline({
        directory: dir,
        runId: "run",
        attemptId: "attempt",
        commitSha: null,
        registry: new BuyerAttemptRegistry(1),
        nonceSource: () => NONCE_A,
        signer,
        now: SIGNING_TIME,
        prepared: prepared(),
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_BUYER_ARTIFACT_OVERWRITE));
    expect(signer.calls).toBe(0);
    expect(existsSync(join(dir, SIGNED_ARTIFACT))).toBe(false);
  });

  it("refuses to persist a signature with no unsigned artifact present", async () => {
    const { persistSignedArtifact } = await import(
      "../../tools/trustforge/buyer-authorization-artifacts"
    );
    const dir = workDir();
    expect(() =>
      persistSignedArtifact(dir, {
        schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
        run_id: "r", attempt_id: "a", commit_sha: null, created_at: OBSERVED_AT,
        state: "SIGNED_PERSISTED",
        unsigned_artifact_path: UNSIGNED_ARTIFACT,
        unsigned_artifact_sha256: "x", unsigned_payload_sha256: "y",
        signer_address: BUYER, signature: SIGNATURE,
        signature_encoding: "eip712-65-byte-hex",
        canonical_signed_payload_sha256: "z", signed_at: OBSERVED_AT,
        payment_header_created: false, payment_bearing_request_count: 0,
        sent: false, retry_allowed: false,
      }),
    ).toThrow(new RegExp(BLOCKED_BUYER_ARTIFACT_ORDER));
  });

  it("never overwrites an existing artifact", () => {
    const dir = workDir();
    const path = join(dir, "once.json");
    writeArtifactOnce(path, { a: 1 });
    expect(() => writeArtifactOnce(path, { a: 2 })).toThrow(
      new RegExp(BLOCKED_BUYER_ARTIFACT_OVERWRITE),
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1 });
  });

  it("a re-run after a crash cannot reuse the nonce or the attempt", async () => {
    const dir = workDir();
    const registry = new BuyerAttemptRegistry(1);
    await runBuyerAuthorizationPipeline({
      directory: dir, runId: "run", attemptId: "attempt", commitSha: null,
      registry, nonceSource: () => NONCE_A, signer: fixtureSigner(),
      now: SIGNING_TIME, prepared: prepared(),
    });
    await expect(
      runBuyerAuthorizationPipeline({
        directory: dir, runId: "run", attemptId: "attempt", commitSha: null,
        registry, nonceSource: () => NONCE_A, signer: fixtureSigner(),
        now: SIGNING_TIME, prepared: prepared(),
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_BUYER_ATTEMPT_DUPLICATE));
  });

  it("records the full unsigned artifact contract", async () => {
    const dir = workDir();
    await runBuyerAuthorizationPipeline({
      directory: dir, runId: "run", attemptId: "attempt", commitSha: "abc1234",
      registry: new BuyerAttemptRegistry(1), nonceSource: () => NONCE_A,
      signer: fixtureSigner(), now: SIGNING_TIME, prepared: prepared(),
    });
    const artifact = JSON.parse(readFileSync(join(dir, UNSIGNED_ARTIFACT), "utf8"));
    for (const field of [
      "schema_version", "run_id", "attempt_id", "created_at", "signing_time",
      "human_authorization_sha256", "canonical_requirements_sha256",
      "canonical_envelope_sha256", "request_binding_sha256", "endpoint", "method",
      "protocol_version", "seller_network_raw", "canonical_network_caip2", "chain_id",
      "asset", "pay_to", "seller_amount_atomic", "maximum_authorized_amount_atomic",
      "buyer_wallet", "paytime_requirements_observed_at", "effective_signing_deadline",
      "valid_after", "valid_before", "nonce", "domain", "types", "primary_type",
      "message", "canonical_unsigned_payload_sha256", "state",
    ]) {
      expect(artifact, `missing ${field}`).toHaveProperty(field);
    }
    expect(artifact.state).toBe("UNSIGNED_PERSISTED");
    expect(artifact.chain_id).toBe(8453);

    const signed = JSON.parse(readFileSync(join(dir, SIGNED_ARTIFACT), "utf8"));
    expect(signed.state).toBe("SIGNED_PERSISTED");
    expect(signed.payment_header_created).toBe(false);
    expect(signed.payment_bearing_request_count).toBe(0);
    expect(signed.sent).toBe(false);
    expect(signed.retry_allowed).toBe(false);
    expect(signed.unsigned_payload_sha256).toBe(artifact.canonical_unsigned_payload_sha256);

    const abandoned = JSON.parse(
      readFileSync(join(dir, "buyer_authorization_abandoned.json"), "utf8"),
    );
    expect(abandoned.state).toBe("TERMINAL_ABANDONED_REAUTHORIZE");
    expect(abandoned.resumable_for_send).toBe(false);
    expect(abandoned.signature_reusable).toBe(false);
    expect(abandoned.requires_reauthorization).toBe(true);
  });
});

// ---------------------------------------------------------------- hashes
describe("canonical hashing", () => {
  const base = () => buildUnsignedBuyerAuthorization({ ...prepared(), nonce: NONCE_A });

  it("property order does not change the hash", () => {
    const a = canonicalJsonSha256({ x: 1, y: 2 });
    const b = canonicalJsonSha256({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("array order does change the hash", () => {
    expect(canonicalJsonSha256([1, 2])).not.toBe(canonicalJsonSha256([2, 1]));
  });

  it.each([
    ["nonce", () => buildUnsignedBuyerAuthorization({ ...prepared(), nonce: NONCE_B })],
    ["amount", () => buildUnsignedBuyerAuthorization({ ...prepared({ obs: observation({ amount: "1001" }) }), nonce: NONCE_A })],
    ["payTo", () => buildUnsignedBuyerAuthorization({ ...prepared({ obs: observation({ payTo: "0x6666666666666666666666666666666666666666" }), human: humanAuthorization({ pay_to: "0x6666666666666666666666666666666666666666" }) }), nonce: NONCE_A })],
    ["buyer", () => buildUnsignedBuyerAuthorization({ ...prepared({ buyer: "0x7777777777777777777777777777777777777777" }), nonce: NONCE_A })],
    ["validity window", () => buildUnsignedBuyerAuthorization({ ...prepared({ obs: observation({ maxTimeoutSeconds: 120 }) }), nonce: NONCE_A })],
    ["domain", () => buildUnsignedBuyerAuthorization({ ...prepared({ obs: observation({ extra: { name: "Other", version: "2" } }) }), nonce: NONCE_A })],
  ])("changing the %s changes the unsigned payload hash", (_label, build) => {
    expect(build().canonical_unsigned_payload_sha256).not.toBe(
      base().canonical_unsigned_payload_sha256,
    );
  });

  it("a different signature changes the signed payload hash", async () => {
    const unsigned = base();
    const first = await signUnsignedAuthorization({
      unsigned, signer: fixtureSigner(), now: SIGNING_TIME,
    });
    const other: InjectedTypedDataSigner = {
      address: BUYER,
      async signTypedData() {
        return `0x${"cd".repeat(65)}`;
      },
    };
    const second = await signUnsignedAuthorization({ unsigned, signer: other, now: SIGNING_TIME });
    expect(first.canonical_signed_payload_sha256).not.toBe(second.canonical_signed_payload_sha256);
  });

  it("refuses a signer that is not the authorized buyer", async () => {
    await expect(
      signUnsignedAuthorization({
        unsigned: base(),
        signer: fixtureSigner("0x9999999999999999999999999999999999999999"),
        now: SIGNING_TIME,
      }),
    ).rejects.toThrow(new RegExp(BLOCKED_BUYER_SIGNER_ADDRESS_MISMATCH));
  });
});

// ---------------------------------------------------------------- state machine
describe("state machine", () => {
  it("allows only the B.2 order", () => {
    assertLegalTransition("RESERVED", "UNSIGNED_PERSISTED");
    assertLegalTransition("UNSIGNED_PERSISTED", "SIGNED_PERSISTED");
    expect(() => assertLegalTransition("RESERVED", "SIGNED_PERSISTED")).toThrow(
      new RegExp(BLOCKED_BUYER_AUTHORIZATION_ILLEGAL_TRANSITION),
    );
    expect(() => assertLegalTransition("UNSIGNED_PERSISTED", "RESERVED")).toThrow(
      new RegExp(BLOCKED_BUYER_AUTHORIZATION_ILLEGAL_TRANSITION),
    );
  });

  it("cannot reach a send state in this phase", () => {
    for (const state of B2_FORBIDDEN_STATES) {
      expect(() => assertReachableInB2(state)).toThrow(
        new RegExp(BLOCKED_BUYER_AUTHORIZATION_SEND_NOT_IMPLEMENTED),
      );
    }
  });

  it("abandons anything signed but not sent", () => {
    expect(terminalStateForUnsentAttempt("SIGNED_PERSISTED")).toBe(
      "TERMINAL_ABANDONED_REAUTHORIZE",
    );
    expect(terminalStateForUnsentAttempt("UNSIGNED_PERSISTED")).toBe(
      "TERMINAL_ABANDONED_REAUTHORIZE",
    );
    expect(isTerminalState("TERMINAL_ABANDONED_REAUTHORIZE")).toBe(true);
    expect(legalNextStates("TERMINAL_ABANDONED_REAUTHORIZE")).toEqual([]);
  });

  it("never resumes a signed payload for send", () => {
    expect(() => assertNotResumableForSend("SIGNED_PERSISTED")).toThrow(
      new RegExp(BLOCKED_BUYER_AUTHORIZATION_RESUME_FORBIDDEN),
    );
  });

  it("has no send implementation wired anywhere", () => {
    const source = readFileSync(
      "tools/trustforge/buyer-authorization-state-machine.ts",
      "utf8",
    );
    expect(source).toMatch(/interface PaymentBearingSender/);
    expect(source).not.toMatch(/class .*Sender.* implements PaymentBearingSender/);
  });
});

// ---------------------------------------------------------------- negatives
describe("negative effects", () => {
  it("the B.2 modules never read a wallet env var or open a key file", () => {
    const modules = [
      "tools/trustforge/buyer-authorization-attempt.ts",
      "tools/trustforge/buyer-eip3009-authorization.ts",
      "tools/trustforge/buyer-authorization-artifacts.ts",
      "tools/trustforge/buyer-authorization-state-machine.ts",
    ];
    for (const file of modules) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/process\.env/);
      expect(source, file).not.toMatch(/PRIVATE_KEY/i);
      expect(source, file).not.toMatch(/\.env/);
      expect(source, file).not.toMatch(/privateKeyToAccount/);
      expect(source, file).not.toMatch(/\bfetch\s*\(/);
      expect(source, file).not.toMatch(/X-PAYMENT/i);
    }
  });

  it("performs no network call during a full pipeline run", async () => {
    const spy = vi.spyOn(globalThis, "fetch" as never);
    const dir = workDir();
    await runBuyerAuthorizationPipeline({
      directory: dir, runId: "run", attemptId: "attempt", commitSha: null,
      registry: new BuyerAttemptRegistry(1), nonceSource: () => NONCE_A,
      signer: fixtureSigner(), now: SIGNING_TIME, prepared: prepared(),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("the fixture signer is the only signer and holds no key", () => {
    const signer = fixtureSigner();
    expect(Object.keys(signer).sort()).toEqual(["address", "calls", "signTypedData"]);
    expect(signer.address).toBe(BUYER);
  });
});
