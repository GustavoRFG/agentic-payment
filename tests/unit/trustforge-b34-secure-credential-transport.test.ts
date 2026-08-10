/**
 * B.3.4 secure credential transport — synthetic only; no real keys; no payment.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED } from "../../tools/trustforge/b31-execution-gates";
import {
  BLOCKED_B34_CREDENTIAL_TRANSPORT_AMBIGUOUS,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_CONSUMED,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_FRAME_INVALID,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_SOURCE_UNAUTHORIZED,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAVAILABLE,
} from "../../tools/trustforge/b34-execution-gates";
import { BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED } from "../../tools/trustforge/b3-execution-gates";
import type { UnsignedArtifact } from "../../tools/trustforge/buyer-authorization-artifacts";
import { UNSIGNED_ARTIFACT } from "../../tools/trustforge/buyer-authorization-artifacts";
import { buildSyntheticBuyerCredentialAccessAuthorization } from "../../tools/trustforge/buyer-credential-access-authorization";
import { runCredentialGatedBuyerSigning } from "../../tools/trustforge/buyer-credential-gated-signing";
import { loadB31CredentialProviderPolicy } from "../../tools/trustforge/b31-credential-provider-policy";
import {
  encodeCredentialTransportFrame,
  decodeCredentialTransportFrame,
  B34_TRANSPORT_MAX_FRAME_LENGTH,
} from "../../tools/trustforge/buyer-credential-transport-frame";
import {
  CredentialTransportLedger,
  createAuthorizedOneShotTransport,
  stampAuthorizedCredentialTransportRead,
} from "../../tools/trustforge/buyer-credential-transport";
import {
  createInProcessCredentialPipe,
  createPipeCredentialTransport,
  spawnCredentialTransportChild,
  writeCredentialFrameToPipe,
} from "../../tools/trustforge/buyer-credential-transport-pipe";
import {
  assertProductionCredentialTransportParentInactive,
  launchSyntheticCredentialTransportChild,
} from "../../tools/trustforge/buyer-credential-transport-parent";
import {
  buildUnsignedBuyerAuthorization,
  canonicalJsonSha256,
} from "../../tools/trustforge/buyer-eip3009-authorization";
import type { PreSignAttemptArtifact } from "../../tools/trustforge/buyer-pre-sign-validation";
import { buildSyntheticBuyerSigningAuthorization } from "../../tools/trustforge/buyer-signing-authorization";
import {
  createExplicitRuntimeKeyCredentialProvider,
  EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
  EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
} from "../../tools/trustforge/explicit-runtime-key-credential-provider";
import { stampAuthorizedCredentialAccessRequest } from "../../tools/trustforge/buyer-credential-provider";
import type { HumanPaymentAuthorization } from "../../tools/trustforge/validate-human-payment-authorization";
import type { SellerRequirementsObservation } from "../../tools/trustforge/x402-seller-requirements-binding";
import type { ValidatedBuyerAuthorizationForSigning } from "../../tools/trustforge/buyer-validated-signing";
import {
  SYNTHETIC_B33_RUNTIME_ADDRESS,
  SYNTHETIC_B33_RUNTIME_KEY,
} from "../support/trustforge-synthetic-runtime-key";
import { createSyntheticCredentialTransportSource } from "../support/trustforge-synthetic-credential-transport-source";

const BUYER = SYNTHETIC_B33_RUNTIME_ADDRESS;
const PAY_TO = "0x2222222222222222222222222222222222222222";
const ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const NONCE = `0x${"11".repeat(32)}`;
const OBSERVED_AT = "2026-01-01T00:00:00.000Z";
const SIGNING_TIME = new Date("2026-01-01T00:01:00.000Z");

const REF_RUN =
  "D:\\trustforge\\artifacts\\runs\\b2-onesource-prepare-only\\run_20260807_131658";
const REF_ATTEMPT_DIR = join(
  REF_RUN,
  "buyer_authorization",
  "attempt_2026-08-07T16-40-38-617Z",
);

const temporaryDirs: string[] = [];
function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "b34-xf-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (temporaryDirs.length) {
    const dir = temporaryDirs.pop();
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function assertNoSecretLeak(text: string): void {
  expect(text.includes(SYNTHETIC_B33_RUNTIME_KEY)).toBe(false);
  expect(text.toLowerCase().includes(SYNTHETIC_B33_RUNTIME_KEY.slice(2).toLowerCase())).toBe(
    false,
  );
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
  };
}

function buildBundle() {
  const h = human();
  const built = buildUnsignedBuyerAuthorization({
    humanAuthorization: h,
    paytimeObservation: observation(),
    authorizedRequirementsSha256: "req-sha",
    authorizedEnvelopeSha256: "env-sha",
    authorizedRequestBindingSha256: "rb-sha",
    authorizedEndpoint: "https://seller.example/api",
    authorizedMethod: "POST",
    buyerAddress: BUYER,
    signingTime: SIGNING_TIME,
    nonce: NONCE,
  });
  const attempt: PreSignAttemptArtifact = {
    schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
    run_id: "run",
    attempt_id: "attempt",
    commit_sha: null,
    created_at: SIGNING_TIME.toISOString(),
    state: "RESERVED",
    reserved_at: SIGNING_TIME.toISOString(),
    endpoint: "https://seller.example/api",
    method: "POST",
    max_payment_attempts: 1,
    allow_retry: false,
  };
  const unsignedArtifact: UnsignedArtifact = {
    schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
    run_id: "run",
    attempt_id: "attempt",
    commit_sha: null,
    created_at: SIGNING_TIME.toISOString(),
    state: "UNSIGNED_PERSISTED",
    signing_time: built.signing_time,
    human_authorization_sha256: canonicalJsonSha256(h),
    canonical_requirements_sha256: "req-sha",
    canonical_envelope_sha256: "env-sha",
    request_binding_sha256: "rb-sha",
    endpoint: "https://seller.example/api",
    method: "POST",
    protocol_version: 1,
    seller_network_raw: "base",
    canonical_network_caip2: "eip155:8453",
    chain_id: 8453,
    asset: ASSET,
    pay_to: PAY_TO,
    seller_amount_atomic: built.seller_amount_atomic,
    maximum_authorized_amount_atomic: built.maximum_authorized_amount_atomic,
    buyer_wallet: BUYER,
    paytime_requirements_observed_at: OBSERVED_AT,
    effective_signing_deadline: built.effective_signing_deadline,
    valid_after: built.message.validAfter,
    valid_before: built.message.validBefore,
    nonce: built.message.nonce,
    domain: built.domain,
    domain_provenance: built.domain_provenance,
    types: built.types,
    primary_type: built.primary_type,
    message: built.message,
    canonical_unsigned_payload_sha256: built.canonical_unsigned_payload_sha256,
  };
  const unsignedHash = canonicalJsonSha256(unsignedArtifact);
  const signingAuthorization = buildSyntheticBuyerSigningAuthorization({
    decisionId: "sign-1",
    prepareAuthorizationSha256: canonicalJsonSha256(h),
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    signingAuthorizationExpiresAt: h.authorization_expires_at!,
  });
  const signingAuthorizationSha256 = canonicalJsonSha256(signingAuthorization);
  const credentialAccessAuthorization = buildSyntheticBuyerCredentialAccessAuthorization({
    decisionId: "cred-1",
    signingAuthorization,
    signingAuthorizationSha256,
    unsignedArtifact,
    unsignedArtifactSha256: unsignedHash,
    providerId: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
    credentialKind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
    expectedSignerAddress: BUYER,
    accessExpiresAt: h.authorization_expires_at!,
  });
  return {
    human: h,
    attempt,
    unsignedArtifact,
    unsignedHash,
    signingAuthorization,
    signingAuthorizationSha256,
    credentialAccessAuthorization,
  };
}

function writeAccessEnabledPolicy(dir: string) {
  const path = join(dir, "credential_provider_policy.json");
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        schema_version: "trustforge_buyer_credential_provider_policy.v2",
        credential_provider_configured: true,
        allowed_provider_ids: [EXPLICIT_RUNTIME_KEY_PROVIDER_ID],
        selected_productive_provider_id: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
        provider_id: EXPLICIT_RUNTIME_KEY_PROVIDER_ID,
        credential_kind: EXPLICIT_RUNTIME_KEY_CREDENTIAL_KIND,
        adapter_installed: true,
        transport_adapter_installed: true,
        expected_signer_address: BUYER,
        credential_access_enabled: true,
        real_backend_activation: false,
        credential_caching_enabled: false,
        automatic_discovery_enabled: false,
        fallback_provider_enabled: false,
        real_signing_enabled: false,
        payment_bearing_send_enabled: false,
        settlement_enabled: false,
        retry_enabled: false,
        effect: "b34 synthetic",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return path;
}

function fakeValidated(
  bundle: ReturnType<typeof buildBundle>,
): ValidatedBuyerAuthorizationForSigning {
  return {
    __brand: "ValidatedBuyerAuthorizationForSigning",
    unsignedArtifact: bundle.unsignedArtifact,
    unsignedArtifactSha256: bundle.unsignedHash,
    signingAuthorization: bundle.signingAuthorization,
    signingAuthorizationSha256: bundle.signingAuthorizationSha256,
    typedData: {
      domain: bundle.unsignedArtifact.domain,
      types: bundle.unsignedArtifact.types,
      primaryType: bundle.unsignedArtifact.primary_type,
      message: bundle.unsignedArtifact.message,
    },
  } as unknown as ValidatedBuyerAuthorizationForSigning;
}

describe("B.3.4 production policy", () => {
  it("transport installed with credential access disabled", () => {
    const policy = loadB31CredentialProviderPolicy();
    expect(policy.transport_adapter_installed).toBe(true);
    expect(policy.adapter_installed).toBe(true);
    expect(policy.credential_access_enabled).toBe(false);
    expect(policy.real_signing_enabled).toBe(false);
  });
});

describe("B.3.4 framing", () => {
  it("round-trips exact 32-byte payload and rejects bad frames", () => {
    const payload = hexToBytes(SYNTHETIC_B33_RUNTIME_KEY);
    const frame = encodeCredentialTransportFrame(payload);
    expect(frame.byteLength).toBe(B34_TRANSPORT_MAX_FRAME_LENGTH);
    const decoded = decodeCredentialTransportFrame(frame);
    expect(Buffer.from(decoded).equals(Buffer.from(payload))).toBe(true);

    expect(() => decodeCredentialTransportFrame(new Uint8Array(0))).toThrow(
      BLOCKED_B34_CREDENTIAL_TRANSPORT_FRAME_INVALID,
    );
    expect(() => decodeCredentialTransportFrame(frame.subarray(0, 10))).toThrow(
      BLOCKED_B34_CREDENTIAL_TRANSPORT_FRAME_INVALID,
    );
    const oversized = new Uint8Array(frame.byteLength + 1);
    oversized.set(frame);
    expect(() => decodeCredentialTransportFrame(oversized)).toThrow(
      BLOCKED_B34_CREDENTIAL_TRANSPORT_FRAME_INVALID,
    );
    const trailing = new Uint8Array([...frame, 0x00]);
    expect(() => decodeCredentialTransportFrame(trailing)).toThrow(
      BLOCKED_B34_CREDENTIAL_TRANSPORT_FRAME_INVALID,
    );
  });
});

describe("B.3.4 one-shot transport", () => {
  it("requires authorization brand and forbids second read", async () => {
    const pipe = createInProcessCredentialPipe();
    const ledger = new CredentialTransportLedger();
    const transport = createPipeCredentialTransport({
      transportId: pipe.transportId,
      readable: pipe.readable,
      ledger,
    });
    const bundle = buildBundle();
    const stamped = stampAuthorizedCredentialAccessRequest({
      accessAuthorization: bundle.credentialAccessAuthorization,
      accessAuthorizationSha256: canonicalJsonSha256(bundle.credentialAccessAuthorization),
      context: {
        expectedSignerAddress: BUYER,
        attemptId: "attempt",
        runId: "run",
        unsignedArtifactSha256: bundle.unsignedHash,
        signingAuthorizationSha256: bundle.signingAuthorizationSha256,
      },
      validated: fakeValidated(bundle),
    });
    const auth = stampAuthorizedCredentialTransportRead({
      transportId: pipe.transportId,
      authorizedRequest: stamped,
    });

    await expect(
      transport.readOnce({ ...(auth as object), __brand: "nope" } as typeof auth),
    ).rejects.toThrow(BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAUTHORIZED);

    const writePromise = writeCredentialFrameToPipe(
      pipe.writable,
      hexToBytes(SYNTHETIC_B33_RUNTIME_KEY),
    );
    const bytes = await transport.readOnce(auth);
    await writePromise;
    expect(bytes.byteLength).toBe(32);

    await expect(transport.readOnce(auth)).rejects.toThrow(
      /BLOCKED_B34_CREDENTIAL_TRANSPORT_CONSUMED|BLOCKED_B34_CREDENTIAL_TRANSPORT_AMBIGUOUS/,
    );
  });

  it("malformed empty frame consumes transport and does not expose secret", async () => {
    const readable = new PassThrough();
    const ledger = new CredentialTransportLedger();
    const transport = createPipeCredentialTransport({
      transportId: "t-empty",
      readable,
      ledger,
      timeoutMs: 1000,
    });
    const bundle = buildBundle();
    const stamped = stampAuthorizedCredentialAccessRequest({
      accessAuthorization: bundle.credentialAccessAuthorization,
      accessAuthorizationSha256: canonicalJsonSha256(bundle.credentialAccessAuthorization),
      context: {
        expectedSignerAddress: BUYER,
        attemptId: "attempt",
        runId: "run",
        unsignedArtifactSha256: bundle.unsignedHash,
        signingAuthorizationSha256: bundle.signingAuthorizationSha256,
      },
      validated: fakeValidated(bundle),
    });
    const auth = stampAuthorizedCredentialTransportRead({
      transportId: "t-empty",
      authorizedRequest: stamped,
    });
    const readPromise = transport.readOnce(auth);
    readable.end(Buffer.alloc(0));
    let thrown = "";
    try {
      await readPromise;
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown).toMatch(/BLOCKED_B34_/);
    assertNoSecretLeak(thrown);
    expect(ledger.getState("t-empty", auth.decisionId, bundle.unsignedHash)).toMatch(
      /CONSUMED|AMBIGUOUS/,
    );
  });
});

describe("B.3.4 production inactive gate", () => {
  it("blocks before pipe read when credential access disabled", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const pipe = createInProcessCredentialPipe();
    const transport = createPipeCredentialTransport({
      transportId: pipe.transportId,
      readable: pipe.readable,
    });
    let reads = 0;
    const counting = createAuthorizedOneShotTransport({
      transportId: pipe.transportId,
      readBytes: async () => {
        reads += 1;
        return hexToBytes(SYNTHETIC_B33_RUNTIME_KEY);
      },
    });
    void transport;
    const provider = createExplicitRuntimeKeyCredentialProvider();
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        provider,
        credentialTransport: counting,
      }),
    ).rejects.toThrow(BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED);
    expect(reads).toBe(0);
    expect(provider.acquireCalls).toBe(0);
  });

  it("parent without synthetic source is unauthorized", async () => {
    expect(() => assertProductionCredentialTransportParentInactive()).toThrow(
      BLOCKED_B34_CREDENTIAL_TRANSPORT_SOURCE_UNAUTHORIZED,
    );
    await expect(
      launchSyntheticCredentialTransportChild({
        source: null,
        scriptPath: "x.js",
      }),
    ).rejects.toThrow(BLOCKED_B34_CREDENTIAL_TRANSPORT_SOURCE_UNAUTHORIZED);
  });
});

describe("B.3.4 synthetic end-to-end via pipe", () => {
  it("parent pipe → transport → runtime-key → send gate", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const pipe = createInProcessCredentialPipe();
    const ledger = new CredentialTransportLedger();
    let transportReads = 0;
    const base = createPipeCredentialTransport({
      transportId: pipe.transportId,
      readable: pipe.readable,
      ledger,
    });
    const transport = {
      transportId: pipe.transportId,
      async readOnce(auth: Parameters<typeof base.readOnce>[0]) {
        transportReads += 1;
        return base.readOnce(auth);
      },
    };
    const provider = createExplicitRuntimeKeyCredentialProvider();
    const writePromise = writeCredentialFrameToPipe(
      pipe.writable,
      hexToBytes(SYNTHETIC_B33_RUNTIME_KEY),
    );
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        nowAtSign: SIGNING_TIME,
        provider,
        credentialPolicyPath: policyPath,
        credentialTransport: transport,
      }),
    ).rejects.toThrow(BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED);
    await writePromise;
    expect(transportReads).toBe(1);
    expect(provider.acquireCalls).toBe(1);
    expect(provider.accountDerivations).toBe(1);
    expect(provider.signerCalls).toBe(1);
    const signed = readFileSync(join(dir, "buyer_authorization_signed.json"), "utf8");
    assertNoSecretLeak(signed);
  });

  it("T1 valid, T2 expired after transport: signer 0", async () => {
    const bundle = buildBundle();
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    writeFileSync(join(dir, UNSIGNED_ARTIFACT), `${JSON.stringify(bundle.unsignedArtifact)}\n`);
    const pipe = createInProcessCredentialPipe();
    const transport = createPipeCredentialTransport({
      transportId: pipe.transportId,
      readable: pipe.readable,
    });
    const provider = createExplicitRuntimeKeyCredentialProvider();
    const after = new Date(bundle.unsignedArtifact.effective_signing_deadline);
    after.setUTCSeconds(after.getUTCSeconds() + 5);
    const writePromise = writeCredentialFrameToPipe(
      pipe.writable,
      hexToBytes(SYNTHETIC_B33_RUNTIME_KEY),
    );
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact: bundle.unsignedArtifact,
        attempt: bundle.attempt,
        humanAuthorization: bundle.human,
        signingAuthorization: bundle.signingAuthorization,
        credentialAccessAuthorization: bundle.credentialAccessAuthorization,
        now: SIGNING_TIME,
        nowAtSign: after,
        provider,
        credentialPolicyPath: policyPath,
        credentialTransport: transport,
      }),
    ).rejects.toThrow();
    await writePromise;
    expect(provider.acquireCalls).toBe(1);
    expect(provider.signerCalls).toBe(0);
  });

  it("stale OneSource: zero transport/provider calls", async () => {
    if (!existsSync(REF_ATTEMPT_DIR)) return;
    const unsignedArtifact = JSON.parse(
      readFileSync(join(REF_ATTEMPT_DIR, UNSIGNED_ARTIFACT), "utf8"),
    ) as UnsignedArtifact;
    const dir = workDir();
    const policyPath = writeAccessEnabledPolicy(dir);
    let reads = 0;
    const transport = createAuthorizedOneShotTransport({
      transportId: "stale",
      readBytes: async () => {
        reads += 1;
        return hexToBytes(SYNTHETIC_B33_RUNTIME_KEY);
      },
    });
    const provider = createExplicitRuntimeKeyCredentialProvider();
    await expect(
      runCredentialGatedBuyerSigning({
        directory: dir,
        unsignedArtifact,
        attempt: {
          schema_version: "trustforge_buyer_authorization_artifact_v0.1.0",
          run_id: unsignedArtifact.run_id,
          attempt_id: unsignedArtifact.attempt_id,
          commit_sha: null,
          created_at: unsignedArtifact.created_at,
          state: "RESERVED",
          reserved_at: unsignedArtifact.created_at,
          endpoint: unsignedArtifact.endpoint,
          method: unsignedArtifact.method,
          max_payment_attempts: 1,
          allow_retry: false,
        },
        humanAuthorization: human(),
        signingAuthorization: buildSyntheticBuyerSigningAuthorization({
          decisionId: "stale",
          prepareAuthorizationSha256: "aa".repeat(32),
          unsignedArtifact,
          unsignedArtifactSha256: "bb".repeat(32),
          signingAuthorizationExpiresAt: "2099-01-01T00:00:00.000Z",
        }),
        now: new Date(),
        provider,
        credentialPolicyPath: policyPath,
        credentialTransport: transport,
      }),
    ).rejects.toThrow();
    expect(reads).toBe(0);
    expect(provider.acquireCalls).toBe(0);
  });
});

describe("B.3.4 spawn child (no shell / no argv secret)", () => {
  it("delivers synthetic frame on fd3 without argv/env leakage", async () => {
    const source = createSyntheticCredentialTransportSource();
    // Plain .mjs so Node inherits fd 3 directly (no TS loader child).
    const childScript = join(
      process.cwd(),
      "tests/support/b34-credential-transport-child.mjs",
    );
    const result = await spawnCredentialTransportChild({
      nodeExecutable: process.execPath,
      scriptPath: childScript,
      syntheticCredentialBytes: source.bytes,
      timeoutMs: 20_000,
      env: {
        ...process.env,
        BUYER_PRIVATE_KEY: "should-be-stripped",
      },
    });
    expect(result.usedShell).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("transport_ok");
    expect(result.argv.join(" ")).not.toContain(SYNTHETIC_B33_RUNTIME_KEY);
    expect(result.envKeys).not.toContain("BUYER_PRIVATE_KEY");
    assertNoSecretLeak(result.stdout);
    assertNoSecretLeak(result.stderr);
    assertNoSecretLeak(result.argv.join(" "));
  });
});

describe("B.3.4 structural guards smoke", () => {
  it("pipe module forbids shell and env key loading", () => {
    const src = readFileSync(
      "tools/trustforge/buyer-credential-transport-pipe.ts",
      "utf8",
    );
    expect(src).toMatch(/shell:\s*false/);
    expect(src).not.toMatch(/shell:\s*true/);
    expect(src).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(src).not.toMatch(/--private-key/);
  });
});
