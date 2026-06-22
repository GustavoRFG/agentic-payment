/**
 * facilitator-settlement-receipt — parse, sanitize, and persist x402 facilitator receipts.
 *
 * Observed @x402/fetch@2.13.0 / @x402/core@2.13.0:
 * - response header: PAYMENT-RESPONSE (case-insensitive via Headers.get)
 * - alias header: X-PAYMENT-RESPONSE
 * - encoding: base64 JSON (decodePaymentResponseHeader)
 * - tx hash field: transaction (SettleResponse)
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodePaymentResponseHeader } from "@x402/core/http";

export type FacilitatorReceiptSource =
  | "payment-response-header"
  | "x-payment-response-header"
  | "response-body"
  | "none";

export type FacilitatorReceiptParseStatus =
  | "parsed"
  | "missing"
  | "malformed"
  | "unsupported";

export interface SanitizedFacilitatorReceipt {
  readonly parseStatus: FacilitatorReceiptParseStatus;
  readonly source: FacilitatorReceiptSource;
  readonly rawHeaderName: string | null;
  readonly transactionHash: `0x${string}` | null;
  readonly network: string | null;
  readonly payer: string | null;
  readonly payTo: string | null;
  readonly asset: string | null;
  readonly amountAtomic: string | null;
  readonly facilitator: string | null;
  readonly settledAtUtc: string | null;
  readonly parseErrorClass: string | null;
}

export interface FacilitatorReceiptArtifact {
  readonly schema_name: "trustforge_facilitator_settlement_receipt";
  readonly schema_version: "1.0.0";
  readonly attempt_id: string;
  readonly run_id: string;
  readonly captured_at_utc: string;
  readonly source: FacilitatorReceiptSource;
  readonly parse_status: FacilitatorReceiptParseStatus;
  readonly transaction_hash: `0x${string}` | null;
  readonly network: string | null;
  readonly payer: string | null;
  readonly pay_to: string | null;
  readonly asset: string | null;
  readonly amount_atomic: string | null;
  readonly facilitator: string | null;
  readonly settled_at_utc: string | null;
  readonly parse_error_class: string | null;
  readonly contains_secret_material: false;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const FORBIDDEN_FIELD_NAMES = new Set([
  "authorization",
  "signature",
  "privatekey",
  "private_key",
  "payment",
  "cookie",
  "apikey",
  "api_key",
  "bearer",
]);

export function normalizeTransactionHash(value: unknown): `0x${string}` | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const normalizedPrefix = trimmed.startsWith("0X") ? `0x${trimmed.slice(2)}` : trimmed;
  if (!TX_HASH_RE.test(normalizedPrefix)) return null;
  return normalizedPrefix.toLowerCase() as `0x${string}`;
}

export function decodeReceiptPayload(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }
  const padded = trimmed
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(trimmed.length / 4) * 4, "=");
  const decoded = Buffer.from(padded, "base64").toString("utf-8");
  return JSON.parse(decoded) as unknown;
}

function readHeaderValue(headers: Pick<Headers, "get">): {
  readonly value: string | null;
  readonly source: FacilitatorReceiptSource;
  readonly rawHeaderName: string | null;
} {
  const paymentResponse = headers.get("payment-response");
  if (paymentResponse?.trim()) {
    return {
      value: paymentResponse,
      source: "payment-response-header",
      rawHeaderName: "payment-response",
    };
  }
  const xPaymentResponse = headers.get("x-payment-response");
  if (xPaymentResponse?.trim()) {
    return {
      value: xPaymentResponse,
      source: "x-payment-response-header",
      rawHeaderName: "x-payment-response",
    };
  }
  return { value: null, source: "none", rawHeaderName: null };
}

function extractHashFromObject(payload: Record<string, unknown>): `0x${string}` | null {
  const direct =
    payload.transaction ??
    payload.transactionHash ??
    payload.transaction_hash ??
    payload.txHash ??
    payload.tx_hash ??
    payload.settlementTxHash ??
    payload.settlement_tx_hash;
  const fromNested =
    direct ??
    (payload.transaction as Record<string, unknown> | undefined)?.hash;
  return normalizeTransactionHash(fromNested);
}

function publicAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(trimmed) ? trimmed : null;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function sanitizeReceiptObject(
  value: unknown,
  meta: {
    readonly source: FacilitatorReceiptSource;
    readonly rawHeaderName: string | null;
    readonly parseErrorClass?: string | null;
    readonly parseStatus?: FacilitatorReceiptParseStatus;
  },
): SanitizedFacilitatorReceipt {
  if (!value || typeof value !== "object") {
    return {
      parseStatus: meta.parseStatus ?? "malformed",
      source: meta.source,
      rawHeaderName: meta.rawHeaderName,
      transactionHash: null,
      network: null,
      payer: null,
      payTo: null,
      asset: null,
      amountAtomic: null,
      facilitator: null,
      settledAtUtc: null,
      parseErrorClass: meta.parseErrorClass ?? "INVALID_RECEIPT_OBJECT",
    };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_FIELD_NAMES.has(key.toLowerCase())) {
      return {
        parseStatus: "malformed",
        source: meta.source,
        rawHeaderName: meta.rawHeaderName,
        transactionHash: null,
        network: null,
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: "FORBIDDEN_FIELD",
      };
    }
  }
  const transactionHash = extractHashFromObject(record);
  const parseStatus =
    meta.parseStatus ??
    (transactionHash ? "parsed" : "malformed");
  return {
    parseStatus,
    source: meta.source,
    rawHeaderName: meta.rawHeaderName,
    transactionHash,
    network: safeString(record.network),
    payer: publicAddress(record.payer),
    payTo: publicAddress(record.payTo ?? record.pay_to),
    asset: publicAddress(record.asset),
    amountAtomic:
      record.amount !== undefined && record.amount !== null
        ? String(record.amount)
        : record.amount_atomic !== undefined && record.amount_atomic !== null
          ? String(record.amount_atomic)
          : null,
    facilitator: safeString(record.facilitator),
    settledAtUtc: safeString(record.settledAtUtc ?? record.settled_at_utc),
    parseErrorClass: transactionHash ? null : meta.parseErrorClass ?? "MISSING_TX_HASH_FIELD",
  };
}

export function extractAndSanitizeFacilitatorReceipt(
  response: Pick<Response, "headers">,
  responseBody?: string,
): SanitizedFacilitatorReceipt {
  const header = readHeaderValue(response.headers);
  if (header.value) {
    try {
      let decoded: unknown;
      try {
        decoded = decodePaymentResponseHeader(header.value);
      } catch {
        decoded = decodeReceiptPayload(header.value);
      }
      const sanitized = sanitizeReceiptObject(decoded, {
        source: header.source,
        rawHeaderName: header.rawHeaderName,
      });
      if (sanitized.parseStatus === "malformed" && sanitized.transactionHash) {
        return { ...sanitized, parseStatus: "parsed", parseErrorClass: null };
      }
      return sanitized;
    } catch {
      return {
        parseStatus: "malformed",
        source: header.source,
        rawHeaderName: header.rawHeaderName,
        transactionHash: null,
        network: null,
        payer: null,
        payTo: null,
        asset: null,
        amountAtomic: null,
        facilitator: null,
        settledAtUtc: null,
        parseErrorClass: "INVALID_BASE64_JSON",
      };
    }
  }

  if (responseBody?.trim()) {
    try {
      const body = JSON.parse(responseBody) as unknown;
      if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        const settlement = record.settlement ?? record.payment ?? record.receipt;
        if (settlement && typeof settlement === "object") {
          return sanitizeReceiptObject(settlement, {
            source: "response-body",
            rawHeaderName: null,
          });
        }
      }
    } catch {
      // body is not JSON settlement metadata
    }
  }

  return {
    parseStatus: "missing",
    source: "none",
    rawHeaderName: null,
    transactionHash: null,
    network: null,
    payer: null,
    payTo: null,
    asset: null,
    amountAtomic: null,
    facilitator: null,
    settledAtUtc: null,
    parseErrorClass: null,
  };
}

export function receiptArtifactFromSanitized(input: {
  readonly receipt: SanitizedFacilitatorReceipt;
  readonly attemptId: string;
  readonly runId: string;
  readonly capturedAtUtc?: string;
}): FacilitatorReceiptArtifact {
  return {
    schema_name: "trustforge_facilitator_settlement_receipt",
    schema_version: "1.0.0",
    attempt_id: input.attemptId,
    run_id: input.runId,
    captured_at_utc: input.capturedAtUtc ?? new Date().toISOString(),
    source: input.receipt.source,
    parse_status: input.receipt.parseStatus,
    transaction_hash: input.receipt.transactionHash,
    network: input.receipt.network,
    payer: input.receipt.payer,
    pay_to: input.receipt.payTo,
    asset: input.receipt.asset,
    amount_atomic: input.receipt.amountAtomic,
    facilitator: input.receipt.facilitator,
    settled_at_utc: input.receipt.settledAtUtc,
    parse_error_class: input.receipt.parseErrorClass,
    contains_secret_material: false,
  };
}

export async function persistFacilitatorReceiptArtifact(input: {
  readonly runDir: string;
  readonly attemptId: string;
  readonly runId: string;
  readonly receipt: SanitizedFacilitatorReceipt;
  readonly capturedAtUtc?: string;
}): Promise<string> {
  await mkdir(input.runDir, { recursive: true });
  const artifact = receiptArtifactFromSanitized({
    receipt: input.receipt,
    attemptId: input.attemptId,
    runId: input.runId,
    capturedAtUtc: input.capturedAtUtc,
  });
  const path = join(input.runDir, `facilitator_receipt_${input.attemptId}.json`);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** @deprecated use extractAndSanitizeFacilitatorReceipt */
export function extractFacilitatorHashFromResponse(response: Response): string | null {
  return extractAndSanitizeFacilitatorReceipt(response).transactionHash;
}

/** @deprecated use extractAndSanitizeFacilitatorReceipt */
export function extractFacilitatorHashFromPaymentResponseHeader(
  headerValue: string | null | undefined,
): string | null {
  if (!headerValue?.trim()) return null;
  const headers = new Headers({ "payment-response": headerValue });
  return extractAndSanitizeFacilitatorReceipt({ headers }).transactionHash;
}
