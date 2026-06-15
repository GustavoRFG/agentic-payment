/**
 * paid-402-response-sanitize — redact secrets and build paid 402 failure artifacts.
 */

import { createHash } from "node:crypto";

const REDACTED = "[REDACTED]" as const;

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-payment",
  "payment-signature",
  "payment-response",
  "x-payment-response",
]);

const PARTIAL_SAFE_HEADER_NAMES = new Set([
  "www-authenticate",
  "payment-required",
  "x-payment-required",
]);

export interface SanitizedPaid402Capture {
  readonly captured_at_utc: string;
  readonly http_status: number;
  readonly http_status_text: string;
  readonly attempt_id: string | null;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly response_headers_sanitized: Record<string, string>;
  readonly response_body_sanitized: unknown;
  readonly response_body_truncated: boolean;
  readonly rejection_analysis: {
    readonly server_rejection_reason: string | null;
    readonly new_payment_requirements_present: boolean;
    readonly scheme_differs_from_unpaid: boolean | null;
    readonly network_differs_from_unpaid: boolean | null;
    readonly amount_differs_from_unpaid: boolean | null;
    readonly facilitator_metadata_present: boolean;
    readonly unpaid_reference: {
      readonly scheme: string | null;
      readonly network: string | null;
      readonly amount_atomic: string | null;
    };
    readonly paid_accept_summary: unknown;
  };
}

export function isSensitiveHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return SENSITIVE_HEADER_NAMES.has(lower);
}

export function sanitizeResponseHeader(name: string, value: string): string {
  const lower = name.trim().toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return REDACTED;
  if (PARTIAL_SAFE_HEADER_NAMES.has(lower)) {
    if (lower === "www-authenticate") {
      return summarizeWwwAuthenticate(value);
    }
    return REDACTED;
  }
  return value;
}

function summarizeWwwAuthenticate(value: string): string {
  const method = value.match(/method="([^"]+)"/i)?.[1] ?? null;
  const intent = value.match(/intent="([^"]+)"/i)?.[1] ?? null;
  const expires = value.match(/expires="([^"]+)"/i)?.[1] ?? null;
  const id = value.match(/\bid="([^"]+)"/i)?.[1] ?? null;
  return [
    "Payment",
    id ? `id="${id}"` : null,
    method ? `method="${method}"` : null,
    intent ? `intent="${intent}"` : null,
    expires ? `expires="${expires}"` : null,
    'request="[REDACTED]"',
  ]
    .filter(Boolean)
    .join(", ");
}

export function sanitizeResponseHeaders(
  headers: Headers | Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key.toLowerCase()] = sanitizeResponseHeader(key, value);
    });
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    out[key.toLowerCase()] = sanitizeResponseHeader(key, value);
  }
  return out;
}

function truncateBody(text: string, maxLen = 8192): { body: unknown; truncated: boolean } {
  if (text.length <= maxLen) {
    try {
      return { body: JSON.parse(text), truncated: false };
    } catch {
      return { body: { raw_text: text }, truncated: false };
    }
  }
  const slice = text.slice(0, maxLen);
  try {
    return {
      body: { truncated_json: JSON.parse(slice), note: `body truncated at ${maxLen} chars` },
      truncated: true,
    };
  } catch {
    return { body: { raw_text: slice, note: `body truncated at ${maxLen} chars` }, truncated: true };
  }
}

function extractAcceptSummary(body: unknown): unknown {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.accepts)) return null;
  return record.accepts.map((entry) => {
    if (!entry || typeof entry !== "object") return entry;
    const a = entry as Record<string, unknown>;
    return {
      scheme: a.scheme ?? null,
      network: a.network ?? null,
      amount: a.amount ?? a.maxAmountRequired ?? null,
      asset: a.asset ?? null,
      payTo: a.payTo ?? null,
    };
  });
}

export function buildPaid402Capture(input: {
  readonly response: Response;
  readonly responseBodyText: string;
  readonly attemptId: string | null;
  readonly provider: string;
  readonly serviceId: string;
  readonly endpoint: string;
  readonly unpaidScheme: string | null;
  readonly unpaidNetwork: string | null;
  readonly unpaidAmountAtomic: string | null;
  readonly now?: () => Date;
}): SanitizedPaid402Capture {
  const now = input.now ?? (() => new Date());
  const headers = sanitizeResponseHeaders(input.response.headers);
  const { body, truncated } = truncateBody(input.responseBodyText);
  const acceptSummary = extractAcceptSummary(body);
  const firstAccept =
    Array.isArray(acceptSummary) && acceptSummary.length > 0
      ? (acceptSummary[0] as Record<string, unknown>)
      : null;

  const rejectionReason =
    body && typeof body === "object" && "error" in (body as object)
      ? String((body as Record<string, unknown>).error)
      : null;

  return {
    captured_at_utc: now().toISOString(),
    http_status: input.response.status,
    http_status_text: input.response.statusText,
    attempt_id: input.attemptId,
    provider: input.provider,
    service_id: input.serviceId,
    endpoint: input.endpoint,
    response_headers_sanitized: headers,
    response_body_sanitized: body,
    response_body_truncated: truncated,
    rejection_analysis: {
      server_rejection_reason: rejectionReason,
      new_payment_requirements_present: Boolean(
        (body &&
          typeof body === "object" &&
          Array.isArray((body as Record<string, unknown>).accepts) &&
          (body as Record<string, unknown>).accepts!.length > 0) ||
          headers["payment-required"] ||
          headers["www-authenticate"],
      ),
      scheme_differs_from_unpaid:
        firstAccept && input.unpaidScheme
          ? String(firstAccept.scheme ?? "") !== input.unpaidScheme
          : null,
      network_differs_from_unpaid:
        firstAccept && input.unpaidNetwork
          ? String(firstAccept.network ?? "") !== input.unpaidNetwork
          : null,
      amount_differs_from_unpaid:
        firstAccept && input.unpaidAmountAtomic
          ? String(firstAccept.amount ?? "") !== input.unpaidAmountAtomic
          : null,
      facilitator_metadata_present: Boolean(
        headers["www-authenticate"]?.includes("facilitator") ||
          (body &&
            typeof body === "object" &&
            JSON.stringify(body).toLowerCase().includes("facilitator")),
      ),
      unpaid_reference: {
        scheme: input.unpaidScheme,
        network: input.unpaidNetwork,
        amount_atomic: input.unpaidAmountAtomic,
      },
      paid_accept_summary: acceptSummary,
    },
  };
}

export function assertNoSecretsInSanitizedCapture(
  capture: SanitizedPaid402Capture,
): readonly string[] {
  const violations: string[] = [];
  const blob = JSON.stringify(capture).toLowerCase();
  for (const token of ["x-payment", "payment-signature", "bearer ", "0x" + "f".repeat(64)]) {
    if (blob.includes(token) && !blob.includes(REDACTED.toLowerCase())) {
      violations.push(`possible secret token: ${token}`);
    }
  }
  for (const value of Object.values(capture.response_headers_sanitized)) {
    if (
      value !== REDACTED &&
      (value.toLowerCase().includes("eyj") || /^0x[0-9a-f]{64,}$/i.test(value))
    ) {
      violations.push("header value looks like a secret");
    }
  }
  return violations;
}

export function paid402CaptureSha256(capture: SanitizedPaid402Capture): string {
  return createHash("sha256").update(JSON.stringify(capture), "utf8").digest("hex");
}

export class PaidRequest402Error extends Error {
  readonly capture: SanitizedPaid402Capture;
  readonly paymentBearingHttpRequestCount: number;
  readonly paymentHeaderCreated: boolean;
  readonly paymentHeaderSent: boolean;

  constructor(
    message: string,
    options: {
      readonly capture: SanitizedPaid402Capture;
      readonly paymentBearingHttpRequestCount: number;
      readonly paymentHeaderCreated: boolean;
      readonly paymentHeaderSent: boolean;
    },
  ) {
    super(message);
    this.name = "PaidRequest402Error";
    this.capture = options.capture;
    this.paymentBearingHttpRequestCount = options.paymentBearingHttpRequestCount;
    this.paymentHeaderCreated = options.paymentHeaderCreated;
    this.paymentHeaderSent = options.paymentHeaderSent;
  }
}

export function formatPaid402CaptureMarkdown(capture: SanitizedPaid402Capture): string {
  const a = capture.rejection_analysis;
  return [
    "# Paid HTTP 402 response (sanitized)",
    "",
    `- Status: **${capture.http_status} ${capture.http_status_text}**`,
    `- Captured: ${capture.captured_at_utc}`,
    `- Provider: ${capture.provider}`,
    `- Service: ${capture.service_id}`,
    `- Endpoint: ${capture.endpoint}`,
    `- Attempt: ${capture.attempt_id ?? "null"}`,
    "",
    "## Rejection analysis",
    "",
    `- Server rejection reason: ${a.server_rejection_reason ?? "not present"}`,
    `- New payment requirements present: ${a.new_payment_requirements_present}`,
    `- Scheme differs from unpaid: ${a.scheme_differs_from_unpaid ?? "unknown"}`,
    `- Network differs from unpaid: ${a.network_differs_from_unpaid ?? "unknown"}`,
    `- Amount differs from unpaid: ${a.amount_differs_from_unpaid ?? "unknown"}`,
    `- Facilitator metadata present: ${a.facilitator_metadata_present}`,
    "",
    "## Unpaid reference",
    "",
    `- scheme: ${a.unpaid_reference.scheme ?? "null"}`,
    `- network: ${a.unpaid_reference.network ?? "null"}`,
    `- amount_atomic: ${a.unpaid_reference.amount_atomic ?? "null"}`,
    "",
    "See `paid_402_response_sanitized.json` for full sanitized headers/body.",
  ].join("\n");
}
