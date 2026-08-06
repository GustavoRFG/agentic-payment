import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  createPaidInvocationGuard,
  type PaidInvocationGuard,
} from "../../buyer-client/src/paid-invocation-guard";
import {
  createPaymentBearingRequestGuard,
  type PaymentBearingRequestGuard,
} from "../../buyer-client/src/payment-bearing-request-guard";
import { assertB2BuyerSignedAuthorizationPipelineImplemented } from "./pre-b2-paid-execution-blocker";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  compareUsdcDecimal,
  requestFromPolicy,
  validateExternalProbeRequest,
  verificationProfileOf,
  type ExternalX402GetProbePolicy,
  type VerificationProfileId,
} from "./external-x402-get-policy";
import {
  inspectExternalX402GetHandshake,
  type ExternalHandshakeInspection,
} from "./external-x402-get-adapter";

export const TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV =
  "TRUSTFORGE_EXTERNAL_PAID_SMOKE_ARMED" as const;
export const TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE =
  "YES_I_AUTHORIZE_ONE_PAYMENT" as const;

export type ExternalPaidProbeState =
  | "INIT"
  | "POLICY_VALIDATED"
  | "UNPAID_HANDSHAKE_CONFIRMED"
  | "GROUND_TRUTH_BEFORE_CONFIRMED"
  | "ARMING_CONFIRMED"
  | "WALLET_LOAD_STARTED"
  | "WALLET_READY"
  | "PAYMENT_ATTEMPTED"
  | "PAYMENT_RESPONSE_RECEIVED"
  | "RECEIPT_OR_SETTLEMENT_EVIDENCE_VALIDATED"
  | "GROUND_TRUTH_AFTER_CONFIRMED"
  | "SEMANTIC_VERIFICATION_COMPLETED"
  | "PASS"
  | "FAIL_CLOSED_BEFORE_WALLET_LOAD"
  | "FAIL_BEFORE_PAYMENT"
  | "FAIL_AFTER_PAYMENT";

export type ExternalPaidProbeMode = "readiness-only" | "execute-paid";

export interface ExternalPaidExecutionRequest {
  readonly policyId: string;
  readonly url: string;
  readonly method: string;
  readonly allowedNetwork: string;
  readonly allowedAsset: string;
  readonly maxPricePerCallUsdc: string;
  readonly maxTotalSpendUsdc: string;
  readonly maxPaymentAttempts: number;
  readonly allowRedirects: boolean;
  readonly allowRetries: boolean;
  readonly allowFallback: boolean;
  readonly batch?: boolean;
  readonly loop?: boolean;
  readonly scheduler?: boolean;
  readonly readinessOnly: boolean;
  readonly executePaid: boolean;
  readonly runId?: string;
  readonly armingEnvValue?: string;
}

export interface GroundTruthResult {
  readonly ok: boolean;
  readonly chainIdHex?: string;
  readonly chainIdDecimal?: number;
  readonly blockNumberHex?: string;
  readonly blockNumberDecimal?: number;
  readonly sources?: readonly string[];
  readonly error?: string;
}

export interface WalletHandle {
  readonly walletFingerprint: string;
  readonly publicAddress?: string;
  readonly signer?: unknown;
}

export interface PaidResponse {
  readonly httpStatus: number;
  readonly responseHeadersSanitized: Record<string, string>;
  readonly responseBodySanitized: unknown;
  readonly responseBodySha256: string;
  readonly responseBodyParseable?: boolean;
  readonly observedChainId?: string | number | null;
  /** Generic observed semantic value (chain id or block number per profile). */
  readonly observedValue?: string | number | null;
  readonly actualAmountUsdc?: string | null;
  readonly network?: string | null;
  readonly asset?: string | null;
  readonly transactionHash?: string | null;
  readonly receipt?: unknown | null;
  readonly settlementEvidence?: unknown | null;
  readonly paymentEvidence?: unknown | null;
  readonly paymentInvocationCount?: number;
  readonly paymentBearingRequestCount?: number;
  readonly totalHttpRequestCount?: number;
}

export interface ExternalPaidRequestContext {
  readonly paidInvocationGuard: PaidInvocationGuard;
  readonly paymentBearingGuard: PaymentBearingRequestGuard;
}

export interface ExternalPaidProbeDependencies {
  readonly inspectHandshake: (
    policy: ExternalX402GetProbePolicy,
  ) => Promise<ExternalHandshakeInspection>;
  readonly verifyGroundTruthBefore: (
    policy: ExternalX402GetProbePolicy,
  ) => Promise<GroundTruthResult>;
  readonly verifyGroundTruthAfter: (
    policy: ExternalX402GetProbePolicy,
  ) => Promise<GroundTruthResult>;
  readonly loadWallet: (
    policy: ExternalX402GetProbePolicy,
    inspection: ExternalHandshakeInspection,
  ) => Promise<WalletHandle>;
  readonly performPaidRequest: (
    policy: ExternalX402GetProbePolicy,
    wallet: WalletHandle,
    inspection: ExternalHandshakeInspection,
    context: ExternalPaidRequestContext,
  ) => Promise<PaidResponse>;
  readonly now?: () => Date;
}

export interface ExternalPaidProbeOptions {
  readonly policy: ExternalX402GetProbePolicy;
  readonly request: ExternalPaidExecutionRequest;
  readonly mode: ExternalPaidProbeMode;
}

export interface ExternalPaidProbeResult {
  readonly status:
    | "PASS"
    | "FAIL_CLOSED_BEFORE_WALLET_LOAD"
    | "FAIL_BEFORE_PAYMENT"
    | "FAIL_AFTER_PAYMENT";
  readonly terminalState: ExternalPaidProbeState;
  readonly states: readonly ExternalPaidProbeState[];
  readonly policyId: string;
  readonly serviceId: string;
  readonly runId: string | null;
  readonly readinessOnly: boolean;
  readonly executePaid: boolean;
  readonly handshake: ExternalHandshakeInspection | null;
  readonly groundTruthBefore: GroundTruthResult | null;
  readonly groundTruthAfter: GroundTruthResult | null;
  readonly groundTruth: GroundTruthResult | null;
  readonly paidResponse: PaidResponse | null;
  readonly walletFingerprint: string | null;
  readonly walletLoadStarted: boolean;
  readonly paymentAttempted: boolean;
  readonly paymentAttempts: number;
  readonly paymentBearingRequests: number;
  readonly retryUsed: false;
  readonly fallbackUsed: false;
  readonly schedulerUsed: false;
  readonly paymentHeadersSentLive: boolean;
  readonly error: string | null;
  readonly createdAtUtc: string;
}

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "set-cookie",
  "payment-signature",
  "x-payment",
  "private",
  "secret",
  "signature",
  "signed",
  "payload",
  "token",
];

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sanitizeForExternalPaidEvidence(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForExternalPaidEvidence(entry));
  }
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.some((sensitive) => lower.includes(sensitive))) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitizeForExternalPaidEvidence(entry);
    }
  }
  return out;
}

export function requestFromPaidPolicy(
  policy: ExternalX402GetProbePolicy,
  overrides: Partial<ExternalPaidExecutionRequest> = {},
): ExternalPaidExecutionRequest {
  return {
    ...requestFromPolicy(policy),
    readinessOnly: false,
    executePaid: false,
    runId: undefined,
    armingEnvValue: undefined,
    ...overrides,
  };
}

export function validateExternalPaidExecutionRequest(
  policy: ExternalX402GetProbePolicy,
  request: ExternalPaidExecutionRequest,
): void {
  validateExternalProbeRequest(policy, request);
  if (request.readinessOnly && request.executePaid) {
    throw new Error("--readiness-only cannot be combined with --execute-paid");
  }
  if (request.maxPaymentAttempts !== 1) {
    throw new Error("external paid probe requires maxPaymentAttempts == 1");
  }
  if (compareUsdcDecimal(request.maxTotalSpendUsdc, policy.maxTotalSpendUsdc) > 0) {
    throw new Error("external paid probe total cap exceeds policy");
  }
  if (request.readinessOnly) {
    if (request.armingEnvValue) {
      throw new Error("readiness-only requires paid arming env to be absent");
    }
    return;
  }
  if (!request.executePaid) {
    throw new Error("external paid probe requires --execute-paid");
  }
}

export function validateExternalPaidArming(
  request: ExternalPaidExecutionRequest,
): void {
  if (!request.runId?.trim()) {
    throw new Error("external paid probe requires --run-id");
  }
  if (request.armingEnvValue !== TRUSTFORGE_EXTERNAL_PAID_ARMING_VALUE) {
    throw new Error(
      `external paid probe requires ${TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV}`,
    );
  }
}

export function validateInspectionForPaidPolicy(
  policy: ExternalX402GetProbePolicy,
  inspection: ExternalHandshakeInspection,
): void {
  if (inspection.endpointUrl !== policy.exactUrl) {
    throw new Error("live handshake endpoint mismatch");
  }
  if (inspection.method !== "GET") {
    throw new Error("live handshake method mismatch");
  }
  if (inspection.httpStatus !== 402) {
    throw new Error("live handshake did not return HTTP 402");
  }
  if (inspection.network !== policy.allowedNetwork) {
    throw new Error("live handshake network mismatch");
  }
  if (inspection.asset !== policy.allowedAsset) {
    throw new Error("live handshake asset mismatch");
  }
  if (
    inspection.assetAddress &&
    inspection.assetAddress.toLowerCase() !== MAINNET_USDC_ADDRESS.toLowerCase()
  ) {
    throw new Error("live handshake asset address mismatch");
  }
  if (compareUsdcDecimal(inspection.quoteUsdc, policy.maxPricePerCallUsdc) > 0) {
    throw new Error("live handshake quote exceeds policy");
  }
  if (inspection.redirectObserved) {
    throw new Error("live handshake observed redirect");
  }
  if (inspection.paymentAttempted || inspection.walletUsed) {
    throw new Error("live handshake unexpectedly used wallet or payment");
  }
  if (inspection.requestCount !== 1) {
    throw new Error("live handshake must be exactly one request");
  }
}

export function validateGroundTruth(
  result: GroundTruthResult,
  profile: VerificationProfileId = "ethereum_chain_id",
): void {
  if (profile === "ethereum_block_number") {
    if (
      !result.ok ||
      typeof result.blockNumberDecimal !== "number" ||
      !Number.isInteger(result.blockNumberDecimal) ||
      result.blockNumberDecimal <= 0
    ) {
      throw new Error("ground truth eth_blockNumber check failed");
    }
    return;
  }
  if (!result.ok || result.chainIdHex !== "0x1" || result.chainIdDecimal !== 1) {
    throw new Error("ground truth eth_chainId check failed");
  }
}

export function normalizeBlockNumber(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  const trimmed = value.trim();
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return Number.parseInt(trimmed, 16);
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  return null;
}

export interface ProfileSemanticResult {
  readonly profile: VerificationProfileId;
  readonly pass: boolean;
  readonly observed: number | null;
  readonly lowerBound: number | null;
  readonly upperBound: number | null;
  readonly detail: string;
}

/**
 * Deterministic, profile-aware semantic verification of a paid response against
 * the independent before/after ground truth. Throwing is reserved for the
 * executor; this returns a structured result so callers can record evidence.
 */
export function verifyProfileSemantics(
  policy: ExternalX402GetProbePolicy,
  response: PaidResponse,
  before: GroundTruthResult | null,
  after: GroundTruthResult | null,
): ProfileSemanticResult {
  const profile = verificationProfileOf(policy);
  if (profile === "ethereum_block_number") {
    const tolerance = policy.blockToleranceBlocks ?? 5;
    const observed = normalizeBlockNumber(response.observedValue ?? response.observedChainId);
    const b = before?.blockNumberDecimal ?? null;
    const a = after?.blockNumberDecimal ?? null;
    if (observed === null || b === null || a === null) {
      return {
        profile,
        pass: false,
        observed,
        lowerBound: b,
        upperBound: a,
        detail: "missing observed block number or ground-truth window",
      };
    }
    const lower = Math.min(b, a) - tolerance;
    const upper = Math.max(b, a) + tolerance;
    const pass = observed >= lower && observed <= upper;
    return {
      profile,
      pass,
      observed,
      lowerBound: lower,
      upperBound: upper,
      detail: pass
        ? `observed block ${observed} within [${lower}, ${upper}] (tolerance ${tolerance})`
        : `observed block ${observed} outside [${lower}, ${upper}] (tolerance ${tolerance})`,
    };
  }
  const observed = normalizeChainId(response.observedChainId ?? response.observedValue);
  const pass = observed === 1;
  return {
    profile,
    pass,
    observed,
    lowerBound: 1,
    upperBound: 1,
    detail: pass
      ? "observed chain id resolves to Ethereum mainnet (1)"
      : `observed chain id ${observed ?? "null"} != 1`,
  };
}

function transition(
  states: ExternalPaidProbeState[],
  next: ExternalPaidProbeState,
): void {
  if (next === "PAYMENT_ATTEMPTED" && states.includes("PAYMENT_ATTEMPTED")) {
    throw new Error("payment attempt transition repeated");
  }
  const last = states[states.length - 1];
  if (
    last &&
    last.startsWith("FAIL_") &&
    next !== last
  ) {
    throw new Error("cannot transition from terminal failure");
  }
  states.push(next);
}

function result(
  options: ExternalPaidProbeOptions,
  states: ExternalPaidProbeState[],
  status: ExternalPaidProbeResult["status"],
  values: Partial<ExternalPaidProbeResult>,
): ExternalPaidProbeResult {
  const terminalState = states[states.length - 1] ?? "INIT";
  return {
    status,
    terminalState,
    states,
    policyId: options.policy.policyId,
    serviceId: options.policy.serviceId,
    runId: options.request.runId?.trim() || null,
    readinessOnly: options.mode === "readiness-only",
    executePaid: options.mode === "execute-paid",
    handshake: null,
    groundTruthBefore: null,
    groundTruthAfter: null,
    groundTruth: null,
    paidResponse: null,
    walletFingerprint: null,
    walletLoadStarted: false,
    paymentAttempted: false,
    paymentAttempts: 0,
    paymentBearingRequests: 0,
    retryUsed: false,
    fallbackUsed: false,
    schedulerUsed: false,
    paymentHeadersSentLive: false,
    error: null,
    createdAtUtc: new Date().toISOString(),
    ...values,
  };
}

async function runExternalPaidProbeCore(
  options: ExternalPaidProbeOptions,
  dependencies: ExternalPaidProbeDependencies,
): Promise<ExternalPaidProbeResult> {
  const states: ExternalPaidProbeState[] = ["INIT"];
  const now = dependencies.now ?? (() => new Date());
  let handshake: ExternalHandshakeInspection | null = null;
  let groundTruthBefore: GroundTruthResult | null = null;
  let groundTruthAfter: GroundTruthResult | null = null;
  let wallet: WalletHandle | null = null;
  let walletLoadStarted = false;
  let paidResponse: PaidResponse | null = null;
  let paymentAttempts = 0;
  let paymentBearingRequests = 0;
  let paymentBearingGuard: PaymentBearingRequestGuard | null = null;

  try {
    validateExternalPaidExecutionRequest(options.policy, options.request);
    transition(states, "POLICY_VALIDATED");

    handshake = await dependencies.inspectHandshake(options.policy);
    validateInspectionForPaidPolicy(options.policy, handshake);
    transition(states, "UNPAID_HANDSHAKE_CONFIRMED");

    if (options.mode === "readiness-only") {
      transition(states, "PASS");
      return result(options, states, "PASS", {
        handshake,
        createdAtUtc: now().toISOString(),
      });
    }

    const profile = verificationProfileOf(options.policy);
    groundTruthBefore = await dependencies.verifyGroundTruthBefore(options.policy);
    validateGroundTruth(groundTruthBefore, profile);
    transition(states, "GROUND_TRUTH_BEFORE_CONFIRMED");
    validateExternalPaidArming(options.request);
    transition(states, "ARMING_CONFIRMED");

    transition(states, "WALLET_LOAD_STARTED");
    walletLoadStarted = true;
    wallet = await dependencies.loadWallet(options.policy, handshake);
    transition(states, "WALLET_READY");

    const paidInvocationGuard = createPaidInvocationGuard(1);
    paymentBearingGuard = createPaymentBearingRequestGuard(1);
    paidInvocationGuard.assertNext();
    paymentAttempts = paidInvocationGuard.getAttempts();
    transition(states, "PAYMENT_ATTEMPTED");
    paidResponse = await dependencies.performPaidRequest(options.policy, wallet, handshake, {
      paidInvocationGuard,
      paymentBearingGuard,
    });
    paymentAttempts = paidInvocationGuard.getAttempts();
    paymentBearingRequests = paymentBearingGuard.getPaymentBearingRequests();
    if (paymentAttempts > 1 || paymentBearingRequests > 1) {
      throw new Error("payment attempt cap exceeded");
    }
    if (paymentBearingRequests !== 1) {
      throw new Error("expected exactly one payment-bearing HTTP request");
    }
    transition(states, "PAYMENT_RESPONSE_RECEIVED");

    validatePaidResponseForPolicy(options.policy, handshake, paidResponse);
    transition(states, "RECEIPT_OR_SETTLEMENT_EVIDENCE_VALIDATED");
    groundTruthAfter = await dependencies.verifyGroundTruthAfter(options.policy);
    validateGroundTruth(groundTruthAfter, profile);
    transition(states, "GROUND_TRUTH_AFTER_CONFIRMED");
    const semantics = verifyProfileSemantics(
      options.policy,
      paidResponse,
      groundTruthBefore,
      groundTruthAfter,
    );
    if (!semantics.pass) {
      throw new Error(`semantic verification failed: ${semantics.detail}`);
    }
    transition(states, "SEMANTIC_VERIFICATION_COMPLETED");
    transition(states, "PASS");
    return result(options, states, "PASS", {
      handshake,
      groundTruthBefore,
      groundTruthAfter,
      groundTruth: groundTruthBefore,
      paidResponse,
      walletFingerprint: wallet.walletFingerprint,
      walletLoadStarted,
      paymentAttempted: true,
      paymentAttempts,
      paymentBearingRequests,
      paymentHeadersSentLive: paymentBearingRequests > 0,
      createdAtUtc: now().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const afterPayment = states.includes("PAYMENT_ATTEMPTED");
    const afterWalletStart = walletLoadStarted || states.includes("WALLET_LOAD_STARTED");
    const status: ExternalPaidProbeResult["status"] = afterPayment
      ? "FAIL_AFTER_PAYMENT"
      : afterWalletStart
        ? "FAIL_BEFORE_PAYMENT"
        : "FAIL_CLOSED_BEFORE_WALLET_LOAD";
    transition(states, status);
    return result(options, states, status, {
      handshake,
      groundTruthBefore,
      groundTruthAfter,
      groundTruth: groundTruthBefore,
      paidResponse,
      walletFingerprint: wallet?.walletFingerprint ?? null,
      walletLoadStarted,
      paymentAttempted: afterPayment,
      paymentAttempts,
      paymentBearingRequests:
        paymentBearingGuard?.getPaymentBearingRequests() ?? paymentBearingRequests,
      paymentHeadersSentLive:
        (paymentBearingGuard?.getPaymentBearingRequests() ?? paymentBearingRequests) > 0,
      error: message,
      createdAtUtc: now().toISOString(),
    });
  }
}

export async function runExternalPaidProbe(
  options: ExternalPaidProbeOptions,
  dependencies: ExternalPaidProbeDependencies,
): Promise<ExternalPaidProbeResult> {
  if (options.mode === "execute-paid") {
    assertB2BuyerSignedAuthorizationPipelineImplemented();
  }
  return runExternalPaidProbeCore(options, dependencies);
}

/** Explicit test-only seam for historical deterministic paid-core tests. */
export async function __testOnlyRunExternalPaidProbeCore(
  options: ExternalPaidProbeOptions,
  dependencies: ExternalPaidProbeDependencies,
): Promise<ExternalPaidProbeResult> {
  return runExternalPaidProbeCore(options, dependencies);
}

export function normalizeChainId(value: PaidResponse["observedChainId"]): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "0x1") return 1;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function hasEvidence(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "object" && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

export function validatePaidResponseForPolicy(
  policy: ExternalX402GetProbePolicy,
  inspection: ExternalHandshakeInspection,
  response: PaidResponse,
): void {
  if (response.httpStatus !== 200) {
    throw new Error(`paid response HTTP status ${response.httpStatus}, expected 200`);
  }
  if (response.responseBodyParseable === false) {
    throw new Error("paid response body was not parseable");
  }
  if (!response.actualAmountUsdc) {
    throw new Error("paid response missing actual spend");
  }
  if (compareUsdcDecimal(response.actualAmountUsdc, policy.maxTotalSpendUsdc) > 0) {
    throw new Error("paid response actual spend exceeds total cap");
  }
  if (compareUsdcDecimal(response.actualAmountUsdc, policy.maxPricePerCallUsdc) > 0) {
    throw new Error("paid response actual spend exceeds per-call cap");
  }
  if (compareUsdcDecimal(response.actualAmountUsdc, inspection.quoteUsdc) > 0) {
    throw new Error("paid response actual spend exceeds live quote");
  }
  if (response.network !== policy.allowedNetwork) {
    throw new Error("paid response network mismatch");
  }
  if (response.asset !== policy.allowedAsset) {
    throw new Error("paid response asset mismatch");
  }
  if (
    verificationProfileOf(policy) === "ethereum_chain_id" &&
    normalizeChainId(response.observedChainId) !== 1
  ) {
    throw new Error("paid response chain id did not match Ethereum mainnet");
  }
  if (!hasEvidence(response.paymentEvidence)) {
    throw new Error("paid response missing payment evidence");
  }
  if (!hasEvidence(response.receipt) && !hasEvidence(response.settlementEvidence)) {
    throw new Error("paid response missing receipt or settlement evidence");
  }
  if (
    response.paymentInvocationCount !== undefined &&
    response.paymentInvocationCount > 1
  ) {
    throw new Error("paid response reported more than one payment invocation");
  }
  if (
    response.paymentBearingRequestCount !== undefined &&
    response.paymentBearingRequestCount > 1
  ) {
    throw new Error("paid response reported more than one payment-bearing request");
  }
}

export function defaultExternalPaidReadinessRunDir(date = new Date()): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  const timestamp = [
    date.getUTCFullYear().toString(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "_",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
  return resolve(
    "D:\\trustforge\\artifacts\\runs\\mvp-t0b-readiness",
    `run_${timestamp}`,
  );
}

async function writeText(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8" });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(sanitizeForExternalPaidEvidence(value), null, 2)}\n`);
}

export async function writeExternalPaidReadinessArtifacts(
  runDir: string,
  policy: ExternalX402GetProbePolicy,
  resultValue: ExternalPaidProbeResult,
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeText(
    join(runDir, "00_execution_log.md"),
    [
      "# TrustForge external paid readiness",
      "",
      `created_at_utc: ${resultValue.createdAtUtc}`,
      `policy_id: ${policy.policyId}`,
      `state_path: ${resultValue.states.join(" -> ")}`,
      `status: ${resultValue.status}`,
      `payment_attempted: ${resultValue.paymentAttempted ? "yes" : "no"}`,
      `wallet_used: ${resultValue.walletFingerprint ? "yes" : "no"}`,
      `payment_attempts: ${resultValue.paymentAttempts}`,
      `payment_bearing_requests: ${resultValue.paymentBearingRequests}`,
      `error: ${resultValue.error ?? "null"}`,
      "",
    ].join("\n"),
  );
  await writeJson(join(runDir, "01_policy.json"), policy);
  await writeJson(join(runDir, "02_unpaid_handshake.json"), resultValue.handshake);
  await writeJson(
    join(runDir, "03_ground_truth_before.json"),
    resultValue.groundTruthBefore ?? {
      readiness_only: resultValue.readinessOnly,
      executed: false,
      future_paid_gate: "required_before_wallet_load",
    },
  );
  await writeJson(join(runDir, "04_arming_summary_sanitized.json"), {
    execute_paid_flag: resultValue.executePaid,
    arming_env_present: false,
    run_id_present: Boolean(resultValue.runId),
    readiness_only: resultValue.readinessOnly,
  });
  await writeJson(join(runDir, "05_wallet_summary_sanitized.json"), {
    wallet_load_started: resultValue.walletLoadStarted,
    wallet_fingerprint: resultValue.walletFingerprint,
  });
  await writeJson(join(runDir, "06_paid_request_summary_sanitized.json"), {
    attempted: resultValue.paymentAttempted,
    attempts: resultValue.paymentAttempts,
    payment_bearing_requests: resultValue.paymentBearingRequests,
    retry_used: resultValue.retryUsed,
    fallback_used: resultValue.fallbackUsed,
    payment_headers_sent_live: resultValue.paymentHeadersSentLive,
  });
  await writeText(
    join(runDir, "07_paid_response_status.txt"),
    resultValue.paidResponse
      ? `${resultValue.paidResponse.httpStatus}\n`
      : "not_applicable_or_not_received\n",
  );
  await writeJson(
    join(runDir, "08_paid_response_headers_sanitized.json"),
    resultValue.paidResponse?.responseHeadersSanitized ?? {},
  );
  await writeJson(
    join(runDir, "09_paid_response_body_sanitized.json"),
    resultValue.paidResponse?.responseBodySanitized ?? {},
  );
  await writeJson(
    join(runDir, "10_payment_evidence_sanitized.json"),
    resultValue.paidResponse?.paymentEvidence ?? {},
  );
  await writeJson(
    join(runDir, "11_receipt_sanitized.json"),
    resultValue.paidResponse?.receipt ??
      resultValue.paidResponse?.settlementEvidence ??
      {},
  );
  await writeJson(
    join(runDir, "12_ground_truth_after.json"),
    resultValue.groundTruthAfter ?? {
      executed: false,
      readiness_only: resultValue.readinessOnly,
    },
  );
  await writeJson(join(runDir, "13_probe_run.json"), {
    schema_name: "trustforge_paid_probe_run_readiness",
    schema_version: "0.0.2-one-shot",
    policy_id: policy.policyId,
    service_id: policy.serviceId,
    readiness_only: resultValue.readinessOnly,
    status: resultValue.status,
    state_path: resultValue.states,
    payment_attempted: resultValue.paymentAttempted,
    payment_attempts: resultValue.paymentAttempts,
    payment_bearing_requests: resultValue.paymentBearingRequests,
    wallet_fingerprint: resultValue.walletFingerprint,
    actual_amount_usdc: resultValue.paidResponse?.actualAmountUsdc ?? null,
    http_status_after_payment: resultValue.paidResponse?.httpStatus ?? null,
    transaction_hash: resultValue.paidResponse?.transactionHash ?? null,
    receipt_present: hasEvidence(resultValue.paidResponse?.receipt),
    settlement_evidence_present: hasEvidence(resultValue.paidResponse?.settlementEvidence),
    ground_truth_before: resultValue.groundTruthBefore,
    ground_truth_after: resultValue.groundTruthAfter,
    body_sha256: resultValue.handshake?.responseBodySha256 ?? sha256(""),
    paid_body_sha256: resultValue.paidResponse?.responseBodySha256 ?? null,
    error: resultValue.error,
  });
  await writeText(
    join(runDir, "14_paid_smoke_report.md"),
    [
      "# TrustForge MVP-T0B Paid Executor Readiness",
      "",
      `status: ${resultValue.status}`,
      `policy_id: ${policy.policyId}`,
      `endpoint: ${policy.exactUrl}`,
      `handshake_http_status: ${resultValue.handshake?.httpStatus ?? "null"}`,
      `quote_usdc: ${resultValue.handshake?.quoteUsdc ?? "null"}`,
      `network: ${resultValue.handshake?.network ?? "null"}`,
      `asset: ${resultValue.handshake?.asset ?? "null"}`,
      `wallet_loaded: ${resultValue.walletFingerprint ? "yes" : "no"}`,
      `payment_attempted: ${resultValue.paymentAttempted ? "yes" : "no"}`,
      `payment_attempts: ${resultValue.paymentAttempts}`,
      `payment_bearing_requests: ${resultValue.paymentBearingRequests}`,
      `http_status_after_payment: ${resultValue.paidResponse?.httpStatus ?? "null"}`,
      `actual_spend_usdc: ${resultValue.paidResponse?.actualAmountUsdc ?? "null"}`,
      `receipt_present: ${hasEvidence(resultValue.paidResponse?.receipt) ? "yes" : "no"}`,
      `settlement_evidence_present: ${hasEvidence(resultValue.paidResponse?.settlementEvidence) ? "yes" : "no"}`,
      `ground_truth_before: ${resultValue.groundTruthBefore?.chainIdHex ?? "null"}`,
      `ground_truth_after: ${resultValue.groundTruthAfter?.chainIdHex ?? "null"}`,
      `settlement_attempted: ${resultValue.paymentAttempted ? "unknown_or_captured_by_transport" : "no"}`,
      `error: ${resultValue.error ?? "null"}`,
      "",
    ].join("\n"),
  );
  await writeText(
    join(runDir, "RESULT.txt"),
    [
      "RESULT",
      `status: ${resultValue.status}`,
      `policy_id: ${policy.policyId}`,
      `http_status: ${resultValue.handshake?.httpStatus ?? "null"}`,
      `quote_usdc: ${resultValue.handshake?.quoteUsdc ?? "null"}`,
      `network: ${resultValue.handshake?.network ?? "null"}`,
      `asset: ${resultValue.handshake?.asset ?? "null"}`,
      `payment_attempted: ${resultValue.paymentAttempted ? "yes" : "no"}`,
      `payment_attempts: ${resultValue.paymentAttempts}`,
      `payment_bearing_requests: ${resultValue.paymentBearingRequests}`,
      `wallet_used: ${resultValue.walletFingerprint ? "yes" : "no"}`,
      `settlement_attempted: ${resultValue.paymentAttempted ? "unknown_or_captured_by_transport" : "no"}`,
      `error: ${resultValue.error ?? "null"}`,
      "",
    ].join("\n"),
  );
}

export function liveReadinessDependencies(): ExternalPaidProbeDependencies {
  return {
    inspectHandshake: (policy) => inspectExternalX402GetHandshake(policy),
    verifyGroundTruthBefore: async () => {
      throw new Error("ground truth is not executed in readiness-only mode");
    },
    verifyGroundTruthAfter: async () => {
      throw new Error("ground truth is not executed in readiness-only mode");
    },
    loadWallet: async () => {
      throw new Error("wallet loading is disabled in readiness-only mode");
    },
    performPaidRequest: async () => {
      throw new Error("paid request is disabled in readiness-only mode");
    },
  };
}
