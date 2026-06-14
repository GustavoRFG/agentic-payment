/**
 * refresh-registry-unpaid — re-observe every registered TrustForge service with
 * an UNPAID x402 handshake only. No wallet is loaded, no payment header is sent,
 * nothing is signed, nothing is settled. Plain GET requests per registry
 * metadata; secrets are never echoed.
 *
 * The core (`refreshRegistryUnpaid`) is dependency-injected (fetch + clock) so
 * it is deterministic under unit tests; the live runner wires the real `fetch`.
 */

import { MAINNET_USDC_ADDRESS } from "../../shared/payment-safety";
import { atomicUsdcToDecimal, compareUsdcDecimal } from "./external-x402-get-policy";

const BASE_MAINNET_NETWORK = "eip155:8453";
const QUOTE_CAP_USDC = "0.005";

export type RefreshStatus =
  | "live_402"
  | "changed"
  | "failed"
  | "skipped_missing_safe_template";

export interface RegistryServiceRecord {
  readonly service_id: string;
  readonly endpoint_url: string;
  readonly method: string;
  readonly network: string;
  readonly asset: string;
  readonly last_observed_quote_usdc: string;
  readonly [key: string]: unknown;
}

export interface RegistryDocument {
  readonly schema_name: string;
  readonly registry_version: string;
  readonly generated_at_utc?: string;
  readonly services: RegistryServiceRecord[];
  readonly [key: string]: unknown;
}

export interface RefreshObservation {
  readonly service_id: string;
  readonly endpoint_url: string;
  readonly http_status: number | null;
  readonly refresh_status: RefreshStatus;
  readonly observed_quote_usdc: string | null;
  readonly observed_network: string | null;
  readonly observed_asset: string | null;
  readonly observed_pay_to_present: boolean;
  readonly quote_within_cap: boolean | null;
  readonly drift_from_registry: boolean;
  readonly latency_ms: number | null;
  readonly error: string | null;
  readonly refreshed_at_utc: string;
}

export interface RefreshReport {
  readonly schema_name: "trustforge_registry_refresh_report";
  readonly schema_version: "0.1.0";
  readonly run_id: string;
  readonly generated_at_utc: string;
  readonly services_total: number;
  readonly services_live_402: number;
  readonly services_changed: number;
  readonly services_failed: number;
  readonly services_skipped: number;
  readonly observations: RefreshObservation[];
}

export interface RefreshDeps {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMs?: number;
}

interface AcceptEntry {
  scheme?: string;
  network?: string;
  amount?: string;
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  extra?: { name?: string; asset?: string; assetAddress?: string; tokenAddress?: string };
}

interface Envelope {
  accepts?: AcceptEntry[];
}

function decodeJsonPossiblyBase64(value: string): Envelope | null {
  const trimmed = value.trim();
  try {
    if (trimmed.startsWith("{")) return JSON.parse(trimmed) as Envelope;
    const padded = trimmed
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(trimmed.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Envelope;
  } catch {
    return null;
  }
}

function envelopeFromHeaders(headers: Headers): Envelope | null {
  const direct =
    headers.get("payment-required") ?? headers.get("x-payment-required");
  if (direct) return decodeJsonPossiblyBase64(direct);
  const wwwAuth = headers.get("www-authenticate");
  const match = wwwAuth?.match(/requirements="([^"]+)"/i);
  if (match?.[1]) return decodeJsonPossiblyBase64(match[1]);
  return null;
}

function envelopeFromBody(text: string): Envelope | null {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(value.accepts)) return value as Envelope;
    for (const key of ["paymentRequirements", "x402PaymentRequirements", "requirements"]) {
      const nested = value[key];
      if (nested && typeof nested === "object" && Array.isArray((nested as Envelope).accepts)) {
        return nested as Envelope;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function isUsdc(entry: AcceptEntry): boolean {
  const addr =
    entry.asset ?? entry.extra?.asset ?? entry.extra?.assetAddress ?? entry.extra?.tokenAddress;
  return (
    (typeof addr === "string" && addr.toLowerCase() === MAINNET_USDC_ADDRESS.toLowerCase()) ||
    entry.extra?.name === "USDC" ||
    entry.extra?.name === "USD Coin"
  );
}

function amountAtomic(entry: AcceptEntry): string | undefined {
  return entry.amount ?? entry.maxAmountRequired;
}

interface ParsedRequirements {
  quoteUsdc: string | null;
  network: string | null;
  asset: string | null;
  payToPresent: boolean;
}

function parseRequirements(envelope: Envelope | null): ParsedRequirements | null {
  if (!envelope?.accepts?.length) return null;
  const base = envelope.accepts.filter((e) => e.network === BASE_MAINNET_NETWORK);
  const candidates = (base.length ? base : envelope.accepts).filter(isUsdc);
  const chosenList = candidates.length ? candidates : envelope.accepts;
  let best: { entry: AcceptEntry; quote: string } | null = null;
  for (const entry of chosenList) {
    const atomic = amountAtomic(entry);
    if (!atomic) continue;
    try {
      const quote = atomicUsdcToDecimal(atomic);
      if (!best || compareUsdcDecimal(quote, best.quote) < 0) best = { entry, quote };
    } catch {
      /* ignore unparseable amount */
    }
  }
  const entry = best?.entry ?? chosenList[0];
  return {
    quoteUsdc: best?.quote ?? null,
    network: entry?.network ?? null,
    asset: isUsdc(entry ?? {}) ? "USDC" : (entry?.asset ?? null),
    payToPresent: Boolean(entry?.payTo),
  };
}

async function observeService(
  service: RegistryServiceRecord,
  deps: Required<Pick<RefreshDeps, "fetchImpl" | "now" | "timeoutMs">>,
): Promise<RefreshObservation> {
  const refreshedAt = deps.now().toISOString();
  const base = {
    service_id: service.service_id,
    endpoint_url: service.endpoint_url,
    refreshed_at_utc: refreshedAt,
  };

  if (service.method !== "GET") {
    return {
      ...base,
      http_status: null,
      refresh_status: "skipped_missing_safe_template",
      observed_quote_usdc: null,
      observed_network: null,
      observed_asset: null,
      observed_pay_to_present: false,
      quote_within_cap: null,
      drift_from_registry: false,
      latency_ms: null,
      error: "non-GET method has no safe unpaid template",
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const start = Date.now();
  try {
    const response = await deps.fetchImpl(service.endpoint_url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const latency = Date.now() - start;
    const text = await response.text();

    if (response.status !== 402) {
      return {
        ...base,
        http_status: response.status,
        refresh_status: "changed",
        observed_quote_usdc: null,
        observed_network: null,
        observed_asset: null,
        observed_pay_to_present: false,
        quote_within_cap: null,
        drift_from_registry: true,
        latency_ms: latency,
        error: `expected HTTP 402, got ${response.status}`,
      };
    }

    const parsed =
      parseRequirements(envelopeFromHeaders(response.headers)) ??
      parseRequirements(envelopeFromBody(text));
    if (!parsed) {
      return {
        ...base,
        http_status: 402,
        refresh_status: "failed",
        observed_quote_usdc: null,
        observed_network: null,
        observed_asset: null,
        observed_pay_to_present: false,
        quote_within_cap: null,
        drift_from_registry: false,
        latency_ms: latency,
        error: "HTTP 402 but x402 requirements were not parseable",
      };
    }

    const withinCap =
      parsed.quoteUsdc !== null
        ? compareUsdcDecimal(parsed.quoteUsdc, QUOTE_CAP_USDC) <= 0
        : null;
    const drift =
      parsed.network !== service.network ||
      parsed.asset !== service.asset ||
      (parsed.quoteUsdc !== null &&
        compareUsdcDecimal(parsed.quoteUsdc, service.last_observed_quote_usdc) !== 0);
    const onBaseUsdc = parsed.network === BASE_MAINNET_NETWORK && parsed.asset === "USDC";

    return {
      ...base,
      http_status: 402,
      refresh_status: onBaseUsdc ? "live_402" : "changed",
      observed_quote_usdc: parsed.quoteUsdc,
      observed_network: parsed.network,
      observed_asset: parsed.asset,
      observed_pay_to_present: parsed.payToPresent,
      quote_within_cap: withinCap,
      drift_from_registry: drift,
      latency_ms: latency,
      error: null,
    };
  } catch (error) {
    return {
      ...base,
      http_status: null,
      refresh_status: "failed",
      observed_quote_usdc: null,
      observed_network: null,
      observed_asset: null,
      observed_pay_to_present: false,
      quote_within_cap: null,
      drift_from_registry: false,
      latency_ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshRegistryUnpaid(
  registry: RegistryDocument,
  runId: string,
  deps: RefreshDeps = {},
): Promise<{ report: RefreshReport; updatedRegistry: RegistryDocument }> {
  const resolved = {
    fetchImpl: deps.fetchImpl ?? fetch,
    now: deps.now ?? (() => new Date()),
    timeoutMs: deps.timeoutMs ?? 20_000,
  };

  const observations: RefreshObservation[] = [];
  for (const service of registry.services) {
    observations.push(await observeService(service, resolved));
  }

  const byId = new Map(observations.map((o) => [o.service_id, o]));
  const updatedServices = registry.services.map((service) => {
    const obs = byId.get(service.service_id);
    if (!obs) return service;
    const next: RegistryServiceRecord = { ...service };
    // Update observed timestamp only; keep schema-constrained `status` and the
    // canonical proven quote untouched (proven quote stays <= 0.005 for the
    // contract). The live observation is recorded in `last_refresh`.
    (next as Record<string, unknown>).observed_at_utc = obs.refreshed_at_utc;
    (next as Record<string, unknown>).last_refresh = {
      refresh_status: obs.refresh_status,
      http_status: obs.http_status,
      observed_quote_usdc: obs.observed_quote_usdc,
      observed_network: obs.observed_network,
      observed_asset: obs.observed_asset,
      quote_within_cap: obs.quote_within_cap,
      drift_from_registry: obs.drift_from_registry,
      latency_ms: obs.latency_ms,
      error: obs.error,
      refreshed_at_utc: obs.refreshed_at_utc,
    };
    return next;
  });

  const report: RefreshReport = {
    schema_name: "trustforge_registry_refresh_report",
    schema_version: "0.1.0",
    run_id: runId,
    generated_at_utc: resolved.now().toISOString(),
    services_total: observations.length,
    services_live_402: observations.filter((o) => o.refresh_status === "live_402").length,
    services_changed: observations.filter((o) => o.refresh_status === "changed").length,
    services_failed: observations.filter((o) => o.refresh_status === "failed").length,
    services_skipped: observations.filter(
      (o) => o.refresh_status === "skipped_missing_safe_template",
    ).length,
    observations,
  };

  return {
    report,
    updatedRegistry: { ...registry, services: updatedServices },
  };
}

/** Deterministic, read-only selection helper used by Phase E and unit tests. */
export interface SelectionCandidate {
  readonly service_id: string;
  readonly reason: string;
  readonly observed_quote_usdc: string | null;
}

const DETERMINISTIC_PRIORITY = [
  "onesource_api_block_number",
  "onesource_api_network_info",
] as const;

export function selectSecondDeterministicService(
  observations: readonly RefreshObservation[],
  options: { readonly excludeServiceIds?: readonly string[] } = {},
): SelectionCandidate | null {
  const exclude = new Set(options.excludeServiceIds ?? []);
  const eligible = (o: RefreshObservation): boolean =>
    !exclude.has(o.service_id) &&
    o.refresh_status === "live_402" &&
    o.observed_network === BASE_MAINNET_NETWORK &&
    o.observed_asset === "USDC" &&
    o.quote_within_cap === true;

  for (const id of DETERMINISTIC_PRIORITY) {
    const obs = observations.find((o) => o.service_id === id);
    if (obs && eligible(obs)) {
      return {
        service_id: id,
        reason: `priority deterministic service ${id} is live_402 on Base USDC within cap`,
        observed_quote_usdc: obs.observed_quote_usdc,
      };
    }
  }

  // Fallback: any OneSource chain_metadata service that is eligible.
  const fallback = observations.find(
    (o) => o.service_id.startsWith("onesource_api_") && eligible(o),
  );
  if (fallback) {
    return {
      service_id: fallback.service_id,
      reason: `fallback OneSource deterministic service ${fallback.service_id} eligible`,
      observed_quote_usdc: fallback.observed_quote_usdc,
    };
  }
  return null;
}
