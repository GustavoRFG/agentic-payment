import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createPaidInvocationGuard } from "../../buyer-client/src/paid-invocation-guard";
import { createPaymentBearingRequestGuard } from "../../buyer-client/src/payment-bearing-request-guard";
import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import {
  compareUsdcDecimal,
  requestFromPolicy,
  validateExternalProbeRequest,
  type ExternalX402GetProbePolicy,
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
  | "GROUND_TRUTH_CONFIRMED"
  | "ARMING_CONFIRMED"
  | "WALLET_LOAD_STARTED"
  | "WALLET_READY"
  | "PAYMENT_ATTEMPTED"
  | "PAYMENT_RESPONSE_RECEIVED"
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
  readonly sources?: readonly string[];
  readonly error?: string;
}

export interface WalletHandle {
  readonly walletFingerprint: string;
  readonly publicAddress?: string;
}

export interface PaidResponse {
  readonly httpStatus: number;
  readonly responseHeadersSanitized: Record<string, string>;
  readonly responseBodySanitized: unknown;
  readonly responseBodySha256: string;
  readonly observedChainId?: string | number | null;
  readonly actualAmountUsdc?: string | null;
  readonly transactionHash?: string | null;
  readonly receipt?: unknown;
  readonly paymentEvidence?: unknown;
}

export interface ExternalPaidProbeDependencies {
  readonly inspectHandshake: (
    policy: ExternalX402GetProbePolicy,
  ) => Promise<ExternalHandshakeInspection>;
  readonly verifyGroundTruth: () => Promise<GroundTruthResult>;
  readonly loadWallet: () => Promise<WalletHandle>;
  readonly performPaidRequest: (
    policy: ExternalX402GetProbePolicy,
    wallet: WalletHandle,
    inspection: ExternalHandshakeInspection,
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
  readonly groundTruth: GroundTruthResult | null;
  readonly paidResponse: PaidResponse | null;
  readonly walletFingerprint: string | null;
  readonly walletLoadStarted: boolean;
  readonly paymentAttempted: boolean;
  readonly paymentAttempts: number;
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

export function validateGroundTruth(result: GroundTruthResult): void {
  if (!result.ok || result.chainIdHex !== "0x1" || result.chainIdDecimal !== 1) {
    throw new Error("ground truth eth_chainId check failed");
  }
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
    groundTruth: null,
    paidResponse: null,
    walletFingerprint: null,
    walletLoadStarted: false,
    paymentAttempted: false,
    paymentAttempts: 0,
    retryUsed: false,
    fallbackUsed: false,
    schedulerUsed: false,
    paymentHeadersSentLive: false,
    error: null,
    createdAtUtc: new Date().toISOString(),
    ...values,
  };
}

export async function runExternalPaidProbe(
  options: ExternalPaidProbeOptions,
  dependencies: ExternalPaidProbeDependencies,
): Promise<ExternalPaidProbeResult> {
  const states: ExternalPaidProbeState[] = ["INIT"];
  const now = dependencies.now ?? (() => new Date());
  let handshake: ExternalHandshakeInspection | null = null;
  let groundTruth: GroundTruthResult | null = null;
  let wallet: WalletHandle | null = null;
  let walletLoadStarted = false;
  let paidResponse: PaidResponse | null = null;
  let paymentAttempts = 0;

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

    groundTruth = await dependencies.verifyGroundTruth();
    validateGroundTruth(groundTruth);
    transition(states, "GROUND_TRUTH_CONFIRMED");
    validateExternalPaidArming(options.request);
    transition(states, "ARMING_CONFIRMED");

    transition(states, "WALLET_LOAD_STARTED");
    walletLoadStarted = true;
    wallet = await dependencies.loadWallet();
    transition(states, "WALLET_READY");

    const paidInvocationGuard = createPaidInvocationGuard(1);
    const paymentBearingGuard = createPaymentBearingRequestGuard(1);
    paidInvocationGuard.assertNext();
    paymentAttempts = paidInvocationGuard.getAttempts();
    transition(states, "PAYMENT_ATTEMPTED");
    paidResponse = await dependencies.performPaidRequest(options.policy, wallet, handshake);
    paymentAttempts = paidInvocationGuard.getAttempts();
    if (paymentAttempts > 1 || paymentBearingGuard.getPaymentBearingRequests() > 1) {
      throw new Error("payment attempt cap exceeded");
    }
    transition(states, "PAYMENT_RESPONSE_RECEIVED");

    const observed = normalizeChainId(paidResponse.observedChainId);
    if (observed !== 1) {
      throw new Error("paid response chain id did not match Ethereum mainnet");
    }
    transition(states, "SEMANTIC_VERIFICATION_COMPLETED");
    transition(states, "PASS");
    return result(options, states, "PASS", {
      handshake,
      groundTruth,
      paidResponse,
      walletFingerprint: wallet.walletFingerprint,
      walletLoadStarted,
      paymentAttempted: true,
      paymentAttempts,
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
      groundTruth,
      paidResponse,
      walletFingerprint: wallet?.walletFingerprint ?? null,
      walletLoadStarted,
      paymentAttempted: afterPayment,
      paymentAttempts,
      error: message,
      createdAtUtc: now().toISOString(),
    });
  }
}

function normalizeChainId(value: PaidResponse["observedChainId"]): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "0x1") return 1;
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
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
  return resolve("D:\\trustforge-mvp-t0b-paid-readiness", `run_${timestamp}`);
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
      "payment_attempted: no",
      "wallet_used: no",
      "",
    ].join("\n"),
  );
  await writeJson(join(runDir, "01_policy.json"), policy);
  await writeJson(join(runDir, "02_unpaid_handshake.json"), resultValue.handshake);
  await writeJson(join(runDir, "03_ground_truth_before.json"), {
    readiness_only: resultValue.readinessOnly,
    executed: false,
    future_paid_gate: "required_before_wallet_load",
  });
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
    retry_used: resultValue.retryUsed,
    fallback_used: resultValue.fallbackUsed,
    payment_headers_sent_live: resultValue.paymentHeadersSentLive,
  });
  await writeText(join(runDir, "07_paid_response_status.txt"), "not_applicable_readiness_only\n");
  await writeJson(join(runDir, "08_paid_response_headers_sanitized.json"), {});
  await writeJson(join(runDir, "09_paid_response_body_sanitized.json"), {});
  await writeJson(join(runDir, "10_payment_evidence_sanitized.json"), {});
  await writeJson(join(runDir, "11_receipt_sanitized.json"), {});
  await writeJson(join(runDir, "12_ground_truth_after.json"), {
    executed: false,
    readiness_only: resultValue.readinessOnly,
  });
  await writeJson(join(runDir, "13_probe_run.json"), {
    schema_name: "trustforge_paid_probe_run_readiness",
    schema_version: "0.0.1-readiness",
    policy_id: policy.policyId,
    service_id: policy.serviceId,
    readiness_only: resultValue.readinessOnly,
    status: resultValue.status,
    state_path: resultValue.states,
    payment_attempted: resultValue.paymentAttempted,
    payment_attempts: resultValue.paymentAttempts,
    body_sha256: resultValue.handshake?.responseBodySha256 ?? sha256(""),
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
      "wallet_loaded: no",
      "payment_attempted: no",
      "settlement_attempted: no",
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
      "payment_attempted: no",
      "wallet_used: no",
      "settlement_attempted: no",
      "",
    ].join("\n"),
  );
}

export function liveReadinessDependencies(): ExternalPaidProbeDependencies {
  return {
    inspectHandshake: (policy) => inspectExternalX402GetHandshake(policy),
    verifyGroundTruth: async () => {
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
