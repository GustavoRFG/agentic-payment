/**
 * B.2 prepare-only activation — offline fixtures only.
 *
 * No real keys, no wallet env, no live fetch, no payment headers, no send.
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadB2ActivationPolicy,
  validateB2ActivationPolicy,
  REQUIRED_B2_COMMITS,
} from "../../tools/trustforge/b2-activation-policy";
import {
  BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING,
  BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED,
  BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID,
  BLOCKED_B2_PREPARE_ACTIVATION_POLICY_MISSING,
  BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED,
  BLOCKED_B2_SETTLEMENT_NOT_AUTHORIZED,
  assertB2BuyerSignedAuthorizationPipelineImplemented,
  assertB2RealSignerNotAuthorized,
} from "../../tools/trustforge/b2-execution-gates";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import { runB2PrepareOnly } from "../../tools/trustforge/b2-prepare-only-runner";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";

const BUYER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NONCE = `0x${"11".repeat(32)}`;
const SIGNING_TIME = new Date("2026-01-01T00:01:00.000Z");
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";

const temporaryDirs: string[] = [];
function workDir(prefix = "b2-activate-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
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

function validPolicy(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "trustforge_b2_activation_policy.v1",
    decision: "activate_prepare_only",
    prepare_enabled: true,
    real_signing_enabled: false,
    payment_bearing_send_enabled: false,
    settlement_enabled: false,
    retry_enabled: false,
    required_b2_commits: [...REQUIRED_B2_COMMITS],
    audit_result: "PASS_B2_OFFLINE_AUDIT",
    audit_run: "D:\\trustforge\\artifacts\\runs\\b2-offline-audit\\run_20260806_030405",
    decided_by: "Gustavo Gomes",
    effect: "prepare-only; no private key, signature, payment header, send, or settlement",
    ...overrides,
  };
}

function observation(): SellerRequirementsObservation {
  return {
    requirements_observed_at: OBSERVED_AT,
    selected_requirements: {},
    payment_required_envelope: {},
    ancillary_tempo_evidence: null,
    binding: {
      protocol_version: 1,
      transport: "payment-required-header",
      scheme: "exact",
      seller_network_raw: "base",
      canonical_network_caip2: "eip155:8453",
      asset: ASSET,
      amount_field: "maxAmountRequired",
      amount_atomic: "1000",
      pay_to: PAY_TO,
      max_timeout_seconds: 600,
      resource: null,
      extra: { name: "USD Coin", version: "2" },
      request_binding_sha256: "rb-sha",
      canonical_requirements_sha256: "req-sha",
      canonical_envelope_sha256: "env-sha",
    },
  };
}

function human(): HumanPaymentAuthorization {
  return {
    authorization_schema_version: "trustforge_paid_probe_authorization.v3",
    decision: "authorize_one_payment",
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
  };
}

function selected() {
  return {
    provider: "fixture",
    service_id: "svc",
    endpoint: "https://seller.example/api",
    method: "POST",
    quote_amount_usdc: "0.001",
    quote_atomic: "1000",
    authorized_pay_to: PAY_TO,
    recommended_max_usdc: "0.002",
    network: "eip155:8453",
    asset: ASSET,
    buyer_wallet: BUYER,
    request_binding_sha256: "rb-sha",
    canonical_requirements_sha256: "req-sha",
    canonical_envelope_sha256: "env-sha",
    target_selection_audit: {
      selected_resource_url: "https://seller.example/api",
      handshake_status: "live_402_ok",
      fallback_resource_urls: [],
      scoring_rationale: ["fixture"],
    },
    selected_at_utc: OBSERVED_AT,
  };
}

function writeRun(dir: string, opts: { human?: unknown; selected?: unknown } = {}) {
  writeFileSync(
    join(dir, "human_payment_authorization.json"),
    `${JSON.stringify(opts.human ?? human(), null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    join(dir, "selected_candidate.json"),
    `${JSON.stringify(opts.selected ?? selected(), null, 2)}\n`,
    "utf8",
  );
}

describe("B.2 activation policy", () => {
  it("loads the checked-in prepare-only policy", () => {
    const policy = loadB2ActivationPolicy();
    expect(policy.prepare_enabled).toBe(true);
    expect(policy.real_signing_enabled).toBe(false);
    expect(policy.payment_bearing_send_enabled).toBe(false);
    expect(policy.settlement_enabled).toBe(false);
    expect(policy.retry_enabled).toBe(false);
    expect(policy.audit_result).toBe("PASS_B2_OFFLINE_AUDIT");
  });

  it("missing policy blocks", () => {
    const dir = workDir();
    expect(() => loadB2ActivationPolicy(join(dir, "missing.json"))).toThrow(
      new RegExp(BLOCKED_B2_PREPARE_ACTIVATION_POLICY_MISSING),
    );
  });

  it.each([
    ["schema", { schema_version: "wrong" }],
    ["audit", { audit_result: "BLOCK_B2_OFFLINE_AUDIT" }],
    ["signing true", { real_signing_enabled: true }],
    ["send true", { payment_bearing_send_enabled: true }],
    ["settlement true", { settlement_enabled: true }],
    ["retry true", { retry_enabled: true }],
    ["commit mismatch", { required_b2_commits: ["deadbeef"] }],
  ])("invalid policy (%s) blocks", (_label, override) => {
    const result = validateB2ActivationPolicy(validPolicy(override));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(BLOCKED_B2_PREPARE_ACTIVATION_POLICY_INVALID);
  });
});

describe("B.2 prepare-only productive path", () => {
  it("persists unsigned and stops before any real signer", () => {
    const runDir = workDir("b2-run-");
    const attemptDir = join(runDir, "buyer_authorization", "attempt_1");
    mkdirSync(attemptDir, { recursive: true });
    writeRun(runDir);
    const spy = vi.spyOn(globalThis, "fetch" as never);
    const result = runB2PrepareOnly({
      runDir,
      attemptDir,
      runId: "run",
      attemptId: "attempt_1",
      now: SIGNING_TIME,
      paytimeObservation: observation(),
      nonceSource: () => NONCE,
      policyPath: "config/trustforge_b2_activation_policy.json",
    });
    expect(result.blocker).toBe(BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED);
    expect(result.real_signer_invoked).toBe(false);
    expect(result.sent).toBe(false);
    expect(result.prepare?.state).toBe("UNSIGNED_PERSISTED");
    expect(existsSync(join(attemptDir, UNSIGNED_ARTIFACT))).toBe(true);
    expect(existsSync(join(attemptDir, "buyer_authorization_signed.json"))).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    const unsigned = JSON.parse(readFileSync(join(attemptDir, UNSIGNED_ARTIFACT), "utf8"));
    expect(unsigned.nonce).toBe(NONCE);
    expect(unsigned.message.value).toBe("1000");
  });

  it("blocks before nonce when human authorization is missing", () => {
    const runDir = workDir("b2-run-");
    const attemptDir = join(runDir, "buyer_authorization", "attempt_1");
    mkdirSync(attemptDir, { recursive: true });
    writeFileSync(join(runDir, "selected_candidate.json"), `${JSON.stringify(selected())}\n`);
    const nonceSource = vi.fn(() => NONCE);
    const result = runB2PrepareOnly({
      runDir,
      attemptDir,
      runId: "run",
      attemptId: "attempt_1",
      now: SIGNING_TIME,
      paytimeObservation: observation(),
      nonceSource,
    });
    expect(result.blocker).toBe(BLOCKED_B2_HUMAN_PAYMENT_AUTHORIZATION_MISSING);
    expect(nonceSource).not.toHaveBeenCalled();
    expect(existsSync(join(attemptDir, UNSIGNED_ARTIFACT))).toBe(false);
  });

  it("blocks before nonce when requirements hash mismatches", () => {
    const runDir = workDir("b2-run-");
    const attemptDir = join(runDir, "buyer_authorization", "attempt_1");
    mkdirSync(attemptDir, { recursive: true });
    writeRun(runDir);
    const nonceSource = vi.fn(() => NONCE);
    const bad = observation();
    const result = runB2PrepareOnly({
      runDir,
      attemptDir,
      runId: "run",
      attemptId: "attempt_1",
      now: SIGNING_TIME,
      paytimeObservation: {
        ...bad,
        binding: { ...bad.binding, canonical_requirements_sha256: "other" },
      },
      nonceSource,
    });
    expect(result.prepare).toBeNull();
    expect(nonceSource).not.toHaveBeenCalled();
    expect(result.detail).toMatch(/HASH_MISMATCH|requirements hash/);
  });

  it("blocks expired human authorization before nonce", () => {
    const runDir = workDir("b2-run-");
    const attemptDir = join(runDir, "buyer_authorization", "attempt_1");
    mkdirSync(attemptDir, { recursive: true });
    writeRun(runDir, {
      human: { ...human(), authorization_expires_at: "2026-01-01T00:00:30.000Z" },
    });
    const nonceSource = vi.fn(() => NONCE);
    const result = runB2PrepareOnly({
      runDir,
      attemptDir,
      runId: "run",
      attemptId: "attempt_1",
      now: SIGNING_TIME,
      paytimeObservation: observation(),
      nonceSource,
    });
    expect(nonceSource).not.toHaveBeenCalled();
    expect(result.detail).toMatch(/HUMAN_AUTHORIZATION_EXPIRED/);
  });
});

describe("B.2 productive gates remain closed for signer/send", () => {
  it("real signer gate throws", () => {
    expect(() => assertB2RealSignerNotAuthorized()).toThrow(
      new RegExp(BLOCKED_B2_REAL_SIGNER_NOT_AUTHORIZED),
    );
  });

  it("payment-bearing send gate remains the productive settlement stop", () => {
    expect(() => assertB2BuyerSignedAuthorizationPipelineImplemented()).toThrow(
      /BLOCKED_B2_PAYMENT_BEARING_SEND_NOT_AUTHORIZED/,
    );
    expect(() => assertB2BuyerSignedAuthorizationPipelineImplemented()).toThrow(
      /BLOCKED_B2_BUYER_SIGNED_AUTHORIZATION_PIPELINE_NOT_IMPLEMENTED/,
    );
  });

  it("settlement gate remains closed", () => {
    expect(BLOCKED_B2_SETTLEMENT_NOT_AUTHORIZED).toMatch(/SETTLEMENT_NOT_AUTHORIZED/);
  });

  it("prepare modules never read wallet env or fetch", () => {
    for (const file of [
      "tools/trustforge/b2-prepare-only-runner.ts",
      "tools/trustforge/b2-activation-policy.ts",
      "tools/trustforge/b2-execution-gates.ts",
      "tools/run-trustforge-b2-prepare-only.ts",
    ]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/BUYER_PRIVATE_KEY/);
      expect(source).not.toMatch(/privateKeyToAccount/);
      expect(source).not.toMatch(/wrapFetchWithPayment/);
    }
  });
});
