/**
 * Canonical, side-effect-free request-shape binding for thin x402 settlement.
 *
 * This module deliberately knows nothing about discovery, probes, authorization,
 * wallets, or executors. It only validates/canonicalizes a request and hashes the
 * semantic endpoint + method + query + JSON body tuple.
 */

import { createHash } from "node:crypto";

export const REJECTED_REQUEST_BINDING_NOT_PERSISTED =
  "REJECTED_REQUEST_BINDING_NOT_PERSISTED" as const;
export const REJECTED_REQUEST_BINDING_INVALID =
  "REJECTED_REQUEST_BINDING_INVALID" as const;
export const BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING =
  "BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISSING" as const;
export const BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH =
  "BLOCKED_AUTHORIZATION_REQUEST_BINDING_MISMATCH" as const;
export const BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH =
  "BLOCKED_PLANNED_REQUEST_BINDING_MISMATCH" as const;
export const BLOCKED_INTENT_REQUEST_BINDING_MISMATCH =
  "BLOCKED_INTENT_REQUEST_BINDING_MISMATCH" as const;

export type ThinSettlementRequestMethod = "GET" | "POST";
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };
export type CanonicalQuery = readonly (readonly [string, string])[];

export interface ThinSettlementRequestBinding {
  readonly endpoint: string;
  readonly method: ThinSettlementRequestMethod;
  readonly input_status: "known";
  readonly query: CanonicalQuery;
  readonly body: CanonicalJsonValue | null;
  readonly binding_sha256: string;
}

export interface ThinSettlementRequestSummary {
  readonly method: ThinSettlementRequestMethod;
  readonly endpoint: string;
  readonly query: CanonicalQuery;
  readonly body: CanonicalJsonValue | null;
}

export type RequestInputProvenance =
  | "bazaar.extensions.bazaar.info.input"
  | "legacy_explicit_request_binding"
  | "policy_generated_request_binding";

function fail(detail: string): never {
  throw new Error(`${REJECTED_REQUEST_BINDING_INVALID}: ${detail}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSensitiveFieldName(key: string): boolean {
  return /^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|private[-_]?key|password|secret)$/i.test(
    key,
  );
}

function canonicalizeJson(value: unknown, path = "body"): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${path} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalizeJson(item, `${path}[${index}]`));
  }
  if (isPlainRecord(value)) {
    const result: Record<string, CanonicalJsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (isSensitiveFieldName(key)) fail(`${path}.${key} contains credential material`);
      const child = value[key];
      if (child === undefined) fail(`${path}.${key} is undefined`);
      result[key] = canonicalizeJson(child, `${path}.${key}`);
    }
    return result;
  }
  fail(`${path} contains unsupported value type ${typeof value}`);
}

function canonicalJsonString(value: CanonicalJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonString(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJsonString(value[key]!)}`)
    .join(",")}}`;
}

function queryScalar(value: unknown, path: string): string {
  if (typeof value === "string" || typeof value === "boolean") return String(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  fail(`${path} must be a string, boolean, finite number, or array of those values`);
}

export function canonicalizeThinSettlementQuery(input: unknown): CanonicalQuery {
  const pairs: Array<readonly [string, string]> = [];
  if (Array.isArray(input)) {
    for (let index = 0; index < input.length; index += 1) {
      const pair = input[index];
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string") {
        fail(`query[${index}] must be a [string,string] pair`);
      }
      if (isSensitiveFieldName(pair[0])) {
        fail(`query[${index}][0] contains credential material`);
      }
      pairs.push([pair[0], queryScalar(pair[1], `query[${index}][1]`)]);
    }
  } else if (isPlainRecord(input)) {
    for (const key of Object.keys(input)) {
      if (isSensitiveFieldName(key)) fail(`query.${key} contains credential material`);
      const value = input[key];
      if (Array.isArray(value)) {
        value.forEach((item, index) =>
          pairs.push([key, queryScalar(item, `query.${key}[${index}]`)]),
        );
      } else {
        pairs.push([key, queryScalar(value, `query.${key}`)]);
      }
    }
  } else {
    fail("query must be an object or [string,string][]");
  }
  // Normalize distinct keys deterministically, but keep every value for a repeated
  // key in its original sequence. The sequence and multiplicity are request semantics.
  const valuesByKey = new Map<string, string[]>();
  for (const [key, value] of pairs) {
    const values = valuesByKey.get(key) ?? [];
    values.push(value);
    valuesByKey.set(key, values);
  }
  return [...valuesByKey.keys()]
    .sort()
    .flatMap((key) => valuesByKey.get(key)!.map((value) => [key, value] as const));
}

function normalizeEndpointAndEmbeddedQuery(endpoint: string): {
  readonly endpoint: string;
  readonly query: CanonicalQuery;
} {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    fail("endpoint must be an absolute URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    fail("endpoint protocol must be http or https");
  }
  if (url.username || url.password) fail("endpoint must not contain credentials");
  if (url.hash) fail("endpoint must not contain a fragment");
  const query = canonicalizeThinSettlementQuery([...url.searchParams.entries()]);
  url.search = "";
  return { endpoint: url.toString(), query };
}

function bindingPayload(input: {
  readonly endpoint: string;
  readonly method: ThinSettlementRequestMethod;
  readonly query: CanonicalQuery;
  readonly body: CanonicalJsonValue | null;
}): string {
  return canonicalJsonString({
    body: input.body,
    endpoint: input.endpoint,
    method: input.method,
    query: input.query.map(([key, value]) => [key, value]),
  });
}

export function createThinSettlementRequestBinding(input: {
  readonly endpoint: string;
  readonly method: string;
  readonly input_status: "known";
  readonly query: unknown;
  readonly body: unknown;
}): ThinSettlementRequestBinding {
  if (input.input_status !== "known") {
    fail("input_status must be known");
  }
  const method = input.method.trim().toUpperCase();
  if (method !== "GET" && method !== "POST") {
    fail(`method ${method || "<empty>"} is not GET or POST`);
  }
  const normalizedEndpoint = normalizeEndpointAndEmbeddedQuery(input.endpoint);
  const declaredQuery = canonicalizeThinSettlementQuery(input.query);
  const query = canonicalizeThinSettlementQuery([
    ...normalizedEndpoint.query,
    ...declaredQuery,
  ]);
  if (method === "GET" && input.body !== null && input.body !== undefined) {
    fail("GET request binding must have body null");
  }
  const body = method === "GET" ? null : canonicalizeJson(input.body, "body");
  const payload = bindingPayload({
    endpoint: normalizedEndpoint.endpoint,
    method,
    query,
    body,
  });
  return {
    endpoint: normalizedEndpoint.endpoint,
    method,
    input_status: "known",
    query,
    body,
    binding_sha256: createHash("sha256").update(payload, "utf8").digest("hex"),
  };
}

export function requireThinSettlementRequestBinding(
  value: unknown,
): ThinSettlementRequestBinding {
  if (!isPlainRecord(value)) {
    throw new Error(`${REJECTED_REQUEST_BINDING_NOT_PERSISTED}: request binding missing`);
  }
  if (
    typeof value.endpoint !== "string" ||
    typeof value.method !== "string" ||
    value.input_status !== "known" ||
    !Array.isArray(value.query) ||
    !("body" in value) ||
    typeof value.binding_sha256 !== "string"
  ) {
    throw new Error(`${REJECTED_REQUEST_BINDING_NOT_PERSISTED}: request binding incomplete`);
  }
  const normalized = createThinSettlementRequestBinding({
    endpoint: value.endpoint,
    method: value.method,
    input_status: "known",
    query: value.query,
    body: value.body,
  });
  if (normalized.binding_sha256 !== value.binding_sha256.toLowerCase()) {
    throw new Error(
      `${REJECTED_REQUEST_BINDING_INVALID}: persisted binding_sha256 does not match canonical request shape`,
    );
  }
  return normalized;
}

export function thinSettlementRequestSummary(
  binding: ThinSettlementRequestBinding,
): ThinSettlementRequestSummary {
  const normalized = requireThinSettlementRequestBinding(binding);
  return {
    method: normalized.method,
    endpoint: normalized.endpoint,
    query: normalized.query,
    body: normalized.body,
  };
}

export function bindingFromOutboundRequest(input: {
  readonly endpoint: string;
  readonly method: string;
  readonly body: unknown;
}): ThinSettlementRequestBinding {
  return createThinSettlementRequestBinding({
    endpoint: input.endpoint,
    method: input.method,
    input_status: "known",
    query: [],
    body: input.method.trim().toUpperCase() === "GET" ? null : input.body,
  });
}
