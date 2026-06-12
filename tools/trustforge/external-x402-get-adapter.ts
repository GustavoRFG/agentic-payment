import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  MAINNET_USDC_ADDRESS,
} from "../../shared/payment-safety";
import { containsX402PaymentHeader } from "../../buyer-client/src/payment-bearing-request-guard";
import {
  atomicUsdcToDecimal,
  compareUsdcDecimal,
  requestFromPolicy,
  validateExternalProbeRequest,
  type ExternalX402GetProbePolicy,
} from "./external-x402-get-policy";

export type PaymentRequirementsLocation = "header" | "body" | "both" | "unknown";

interface AcceptEntry {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number | string;
  description?: string;
  mimeType?: string;
  extra?: Record<string, unknown> & {
    name?: string;
    version?: string;
    asset?: string;
    assetAddress?: string;
    tokenAddress?: string;
    contractAddress?: string;
  };
}

interface PaymentRequiredEnvelope {
  x402Version?: number | string;
  error?: string;
  resource?: {
    url?: string;
    description?: string;
    mimeType?: string;
  };
  accepts?: AcceptEntry[];
}

export interface ExternalHandshakeInspection {
  policyId: string;
  serviceId: string;
  endpointUrl: string;
  method: "GET";
  observedAtUtc: string;
  httpStatus: number;
  contentType: string;
  x402VersionObserved: string | null;
  paymentRequirementsLocation: PaymentRequirementsLocation;
  observedTopLevelFields: string[];
  observedPaymentFields: string[];
  scheme: string | null;
  network: string;
  asset: "USDC";
  assetAddress: string | null;
  amountAtomic: string;
  quoteUsdc: string;
  payTo: string;
  maxTimeoutSeconds: number | null;
  resourceDescription: string;
  offerReceiptExtensionAdvertised: boolean;
  redirectObserved: false;
  requestCount: 1;
  paymentAttempted: false;
  walletUsed: false;
  responseHeadersSanitized: Record<string, string>;
  responseBodySanitized: unknown;
  responseBodySha256: string;
  responseHeadersSha256: string;
}

export interface InspectExternalHandshakeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "payment-signature",
  "x-payment",
  "proxy-authorization",
  "x-api-key",
  "www-authenticate",
]);

export function assertExternalPaidExecutionDisabled(): void {
  if (process.env.TRUSTFORGE_EXTERNAL_PAID_ENABLE) {
    throw new Error(
      "external paid execution is disabled in the MVP-T0A adapter",
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function headersToRecord(
  headers: Headers,
  options: { sanitize: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    out[lower] =
      options.sanitize && SENSITIVE_HEADER_NAMES.has(lower) ? "[REDACTED]" : value;
  });
  return out;
}

function sanitizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sanitizeJson(entry));
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("authorization") ||
      lower.includes("cookie") ||
      lower.includes("signature") ||
      lower.includes("private") ||
      lower.includes("secret") ||
      lower.includes("token")
    ) {
      out[key] = "[REDACTED]";
    } else {
      out[key] = sanitizeJson(entry);
    }
  }
  return out;
}

function decodeJsonPossiblyBase64(value: string): PaymentRequiredEnvelope {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as PaymentRequiredEnvelope;
  }

  const padded = trimmed
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(trimmed.length / 4) * 4, "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as PaymentRequiredEnvelope;
}

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === expected) return value;
  }
  return undefined;
}

function decodePaymentRequirementsFromHeaders(
  headers: Record<string, string>,
): PaymentRequiredEnvelope | null {
  const direct =
    getHeaderCaseInsensitive(headers, "payment-required") ??
    getHeaderCaseInsensitive(headers, "x-payment-required");
  if (direct) return decodeJsonPossiblyBase64(direct);

  const wwwAuthenticate = getHeaderCaseInsensitive(headers, "www-authenticate");
  const match = wwwAuthenticate?.match(/requirements="([^"]+)"/i);
  if (match?.[1]) return decodeJsonPossiblyBase64(match[1]);
  return null;
}

function parseBodyJson(bodyText: string, contentType: string): unknown {
  const trimmed = bodyText.trim();
  if (!trimmed) return null;
  const looksJson =
    contentType.toLowerCase().includes("json") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[");
  if (!looksJson) return { rawText: trimmed.slice(0, 2000) };
  return JSON.parse(trimmed);
}

function paymentRequirementsFromBody(value: unknown): PaymentRequiredEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.accepts)) return object as PaymentRequiredEnvelope;
  for (const key of ["paymentRequirements", "x402PaymentRequirements", "requirements"]) {
    const nested = object[key];
    if (
      nested &&
      typeof nested === "object" &&
      !Array.isArray(nested) &&
      Array.isArray((nested as Record<string, unknown>).accepts)
    ) {
      return nested as PaymentRequiredEnvelope;
    }
  }
  return null;
}

function objectKeys(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function extractPaymentRequirements(
  headers: Record<string, string>,
  bodyText: string,
  contentType: string,
): {
  envelope: PaymentRequiredEnvelope;
  location: PaymentRequirementsLocation;
  bodyJson: unknown;
} {
  let headerEnvelope: PaymentRequiredEnvelope | null = null;
  let bodyJson: unknown = null;
  let bodyEnvelope: PaymentRequiredEnvelope | null = null;

  try {
    headerEnvelope = decodePaymentRequirementsFromHeaders(headers);
  } catch (error) {
    throw new Error(`invalid PAYMENT-REQUIRED header: ${(error as Error).message}`);
  }

  try {
    bodyJson = parseBodyJson(bodyText, contentType);
  } catch (error) {
    throw new Error(`invalid 402 response body JSON: ${(error as Error).message}`);
  }
  bodyEnvelope = paymentRequirementsFromBody(bodyJson);

  if (headerEnvelope && bodyEnvelope) {
    return { envelope: headerEnvelope, location: "both", bodyJson };
  }
  if (headerEnvelope) return { envelope: headerEnvelope, location: "header", bodyJson };
  if (bodyEnvelope) return { envelope: bodyEnvelope, location: "body", bodyJson };
  throw new Error("HTTP 402 response did not expose x402 payment requirements");
}

function paymentAssetAddress(entry: AcceptEntry): string | undefined {
  const candidates = [
    entry.asset,
    entry.extra?.asset,
    entry.extra?.assetAddress,
    entry.extra?.tokenAddress,
    entry.extra?.contractAddress,
  ];
  return candidates.find((value): value is string => {
    return typeof value === "string" && value.startsWith("0x");
  });
}

function entryAssetName(entry: AcceptEntry): string | undefined {
  if (entry.extra?.name === "USDC") return "USDC";
  if (entry.extra?.name === "USD Coin") return "USDC";
  return undefined;
}

function isAllowedUsdc(entry: AcceptEntry): boolean {
  const address = paymentAssetAddress(entry);
  return (
    address?.toLowerCase() === MAINNET_USDC_ADDRESS.toLowerCase() ||
    entryAssetName(entry) === "USDC"
  );
}

function amountAtomic(entry: AcceptEntry): string | undefined {
  return entry.amount ?? entry.maxAmountRequired;
}

function selectAcceptEntry(
  policy: ExternalX402GetProbePolicy,
  envelope: PaymentRequiredEnvelope,
): AcceptEntry {
  const accepts = envelope.accepts ?? [];
  if (accepts.length === 0) {
    throw new Error("x402 payment requirements did not include accepts[]");
  }

  const matchingNetwork = accepts.filter((entry) => entry.network === policy.allowedNetwork);
  if (matchingNetwork.length === 0) {
    throw new Error(`x402 requirements did not include network ${policy.allowedNetwork}`);
  }

  const matchingAsset = matchingNetwork.filter(isAllowedUsdc);
  if (matchingAsset.length === 0) {
    throw new Error(`x402 requirements did not include asset ${policy.allowedAsset}`);
  }

  const parseable = matchingAsset
    .map((entry) => {
      const amount = amountAtomic(entry);
      if (!amount) return null;
      try {
        return { entry, quoteUsdc: atomicUsdcToDecimal(amount) };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { entry: AcceptEntry; quoteUsdc: string } => entry !== null);
  if (parseable.length === 0) {
    throw new Error("x402 requirements did not include a parseable USDC amount");
  }

  const cheapest = parseable.reduce((a, b) =>
    compareUsdcDecimal(a.quoteUsdc, b.quoteUsdc) <= 0 ? a : b,
  );
  if (compareUsdcDecimal(cheapest.quoteUsdc, policy.maxPricePerCallUsdc) > 0) {
    throw new Error("x402 quote exceeds policy maxPricePerCallUsdc");
  }
  if (!cheapest.entry.payTo) {
    throw new Error("x402 requirements did not include payTo");
  }
  return cheapest.entry;
}

function parseMaxTimeoutSeconds(value: AcceptEntry["maxTimeoutSeconds"]): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasOfferReceiptExtension(value: unknown): boolean {
  const text = JSON.stringify(value).toLowerCase();
  return text.includes("offerreceipt") || text.includes("offer-receipt") || text.includes("receipt");
}

export async function inspectExternalX402GetHandshake(
  policy: ExternalX402GetProbePolicy,
  options: InspectExternalHandshakeOptions = {},
): Promise<ExternalHandshakeInspection> {
  assertExternalPaidExecutionDisabled();
  validateExternalProbeRequest(policy, requestFromPolicy(policy));

  const headers = new Headers({ accept: "application/json" });
  if (containsX402PaymentHeader(headers)) {
    throw new Error("external dry-run request unexpectedly contains a payment header");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const observedAtUtc = (options.now ?? (() => new Date()))().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(policy.exactUrl, {
      method: policy.method,
      headers,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const responseHeadersRaw = headersToRecord(response.headers, { sanitize: false });
  const responseHeadersSanitized = headersToRecord(response.headers, { sanitize: true });
  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await response.text();
  const responseBodySha256 = sha256(bodyText);
  const responseHeadersSha256 = sha256(JSON.stringify(responseHeadersSanitized));

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`redirect response refused: HTTP ${response.status}`);
  }
  if (response.status !== 402) {
    throw new Error(`expected HTTP 402 from external x402 endpoint; got ${response.status}`);
  }

  const { envelope, location, bodyJson } = extractPaymentRequirements(
    responseHeadersRaw,
    bodyText,
    contentType,
  );
  const accept = selectAcceptEntry(policy, envelope);
  const selectedAmount = amountAtomic(accept);
  if (!selectedAmount) {
    throw new Error("selected x402 accept entry did not include amount");
  }
  const quoteUsdc = atomicUsdcToDecimal(selectedAmount);
  const assetAddress = paymentAssetAddress(accept) ?? null;

  return {
    policyId: policy.policyId,
    serviceId: policy.serviceId,
    endpointUrl: policy.exactUrl,
    method: policy.method,
    observedAtUtc,
    httpStatus: response.status,
    contentType,
    x402VersionObserved:
      envelope.x402Version === undefined ? null : String(envelope.x402Version),
    paymentRequirementsLocation: location,
    observedTopLevelFields: objectKeys(envelope),
    observedPaymentFields: objectKeys(accept),
    scheme: accept.scheme ?? null,
    network: accept.network ?? "",
    asset: "USDC",
    assetAddress,
    amountAtomic: selectedAmount,
    quoteUsdc,
    payTo: accept.payTo ?? "",
    maxTimeoutSeconds: parseMaxTimeoutSeconds(accept.maxTimeoutSeconds),
    resourceDescription: envelope.resource?.description ?? accept.description ?? "",
    offerReceiptExtensionAdvertised: hasOfferReceiptExtension(envelope),
    redirectObserved: false,
    requestCount: 1,
    paymentAttempted: false,
    walletUsed: false,
    responseHeadersSanitized,
    responseBodySanitized: sanitizeJson(bodyJson),
    responseBodySha256,
    responseHeadersSha256,
  };
}

function timestampForPath(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return [
    date.getUTCFullYear().toString(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "_",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

export function defaultExternalProbeRunDir(date = new Date()): string {
  return resolve(
    "D:\\trustforge\\artifacts\\runs\\mvp-t0a-adapter",
    `run_${timestampForPath(date)}`,
  );
}

async function writeText(path: string, content: string): Promise<void> {
  await writeFile(path, content, { encoding: "utf8" });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeExternalProbePreflightArtifacts(
  runDir: string,
  policy: ExternalX402GetProbePolicy,
  inspection: ExternalHandshakeInspection,
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  await writeText(
    join(runDir, "00_execution_log.md"),
    [
      "# TrustForge external x402 GET dry-run",
      "",
      `created_at_utc: ${new Date().toISOString()}`,
      `policy_id: ${policy.policyId}`,
      `endpoint: ${policy.exactUrl}`,
      "payment_attempted: no",
      "wallet_used: no",
      "dry_run_only: yes",
      "",
    ].join("\n"),
  );
  await writeJson(join(runDir, "01_policy.json"), policy);
  await writeJson(join(runDir, "02_request_summary_sanitized.json"), {
    url: policy.exactUrl,
    method: policy.method,
    redirect: "manual",
    retry: "disabled",
    fallback: "disabled",
    payment_headers_sent: false,
    payment_attempted: false,
    wallet_used: false,
  });
  await writeText(join(runDir, "03_unpaid_response_status.txt"), `${inspection.httpStatus}\n`);
  await writeJson(
    join(runDir, "04_unpaid_response_headers_sanitized.txt"),
    inspection.responseHeadersSanitized,
  );
  await writeJson(
    join(runDir, "05_unpaid_response_body_sanitized.json"),
    inspection.responseBodySanitized,
  );
  await writeJson(join(runDir, "06_handshake_inspection.json"), inspection);
  await writeText(
    join(runDir, "07_preflight_report.md"),
    [
      "# TrustForge MVP-T0A External Dry-Run Preflight",
      "",
      "status: PASS",
      `policy_id: ${policy.policyId}`,
      `service_id: ${policy.serviceId}`,
      `endpoint: ${policy.exactUrl}`,
      "method: GET",
      `http_status: ${inspection.httpStatus}`,
      `x402_version: ${inspection.x402VersionObserved ?? "unknown"}`,
      `network: ${inspection.network}`,
      `asset: ${inspection.asset}`,
      `quote_usdc: ${inspection.quoteUsdc}`,
      `pay_to: ${inspection.payTo}`,
      "payment_attempted: no",
      "wallet_used: no",
      "dry_run_only: yes",
      "",
    ].join("\n"),
  );
  await writeText(
    join(runDir, "RESULT.txt"),
    [
      "RESULT",
      "status: PASS",
      `policy_id: ${policy.policyId}`,
      `http_status: ${inspection.httpStatus}`,
      `quote_usdc: ${inspection.quoteUsdc}`,
      `network: ${inspection.network}`,
      `asset: ${inspection.asset}`,
      "payment_attempted: no",
      "wallet_used: no",
      "dry_run_only: yes",
      "",
    ].join("\n"),
  );
}

export async function writeExternalProbeFailureArtifacts(
  runDir: string,
  policy: ExternalX402GetProbePolicy,
  error: unknown,
): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const message = error instanceof Error ? error.message : String(error);
  await writeText(
    join(runDir, "00_execution_log.md"),
    [
      "# TrustForge external x402 GET dry-run",
      "",
      `created_at_utc: ${new Date().toISOString()}`,
      `policy_id: ${policy.policyId}`,
      `endpoint: ${policy.exactUrl}`,
      `error: ${message}`,
      "payment_attempted: no",
      "wallet_used: no",
      "dry_run_only: yes",
      "",
    ].join("\n"),
  );
  await writeJson(join(runDir, "01_policy.json"), policy);
  await writeText(
    join(runDir, "07_preflight_report.md"),
    [
      "# TrustForge MVP-T0A External Dry-Run Preflight",
      "",
      "status: FAIL",
      `policy_id: ${policy.policyId}`,
      `endpoint: ${policy.exactUrl}`,
      `error: ${message}`,
      "payment_attempted: no",
      "wallet_used: no",
      "dry_run_only: yes",
      "",
    ].join("\n"),
  );
  await writeText(
    join(runDir, "RESULT.txt"),
    [
      "RESULT",
      "status: FAIL",
      `policy_id: ${policy.policyId}`,
      `error: ${message}`,
      "payment_attempted: no",
      "wallet_used: no",
      "dry_run_only: yes",
      "",
    ].join("\n"),
  );
}
