/**
 * provider-blocklist — evidence-backed exclusion of x402 provider domains.
 *
 * Domains in entries[] of config/x402_provider_blocklist.json are dropped from
 * discovery/adapt BEFORE ranking, each drop recorded as SKIPPED_BLOCKLISTED in
 * the candidate evidence. Entries are added by evidence and removed only by a
 * human editing the file — this module never mutates the blocklist.
 *
 * watch[] is a SEPARATE, non-excluding list. The blocklist is strictly
 * evidence-based (a domain is blocked only on its own failing runs), so peers
 * that merely share an apparent operator with a blocked domain — no run of their
 * own — are recorded on the watch list for attention but never excluded. Watch
 * membership is intentionally invisible to partitionByBlocklist / isDomainBlocklisted.
 */

import { readFileSync } from "node:fs";
import { repoPath } from "./contracts";

export const SKIPPED_BLOCKLISTED = "SKIPPED_BLOCKLISTED";

export const PROVIDER_BLOCKLIST_PATH = repoPath("config", "x402_provider_blocklist.json");

export interface ProviderBlocklistEntry {
  readonly domain: string;
  readonly reason: string;
  readonly evidence_runs: readonly string[];
  readonly added_at: string;
  /**
   * Optional note when the original evidence has been reinterpreted (e.g. a 405
   * traced to our own POST-to-GET mismatch rather than a seller defect). The entry
   * is kept until the root cause is addressed; removal remains a human decision.
   */
  readonly reinterpretation?: string;
}

/**
 * A watched domain: recorded for attention (e.g. it shares an apparent operator
 * with a blocked peer) but NOT excluded from discovery/adapt. It carries no
 * evidence_runs because, by policy, a watch entry has no failing run of its own.
 */
export interface ProviderWatchEntry {
  readonly domain: string;
  readonly reason: string;
  readonly related_to?: string;
  readonly added_at: string;
  readonly note?: string;
}

export interface ProviderBlocklist {
  readonly schema_name?: string;
  readonly schema_version?: string;
  readonly note?: string;
  readonly watch_note?: string;
  readonly entries: readonly ProviderBlocklistEntry[];
  readonly watch?: readonly ProviderWatchEntry[];
}

export const EMPTY_PROVIDER_BLOCKLIST: ProviderBlocklist = { entries: [] };

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error) && typeof error === "object" && "code" in (error as object);
}

/**
 * Read the versioned blocklist from disk. A missing file yields an empty
 * blocklist (the file is version-controlled and expected to exist); a malformed
 * file throws, because silently ignoring a corrupt blocklist would drop a
 * deliberate exclusion.
 */
export function loadProviderBlocklist(path: string = PROVIDER_BLOCKLIST_PATH): ProviderBlocklist {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return EMPTY_PROVIDER_BLOCKLIST;
    throw error;
  }
  const parsed = JSON.parse(raw) as ProviderBlocklist;
  if (!parsed || !Array.isArray(parsed.entries)) {
    throw new Error(`malformed provider blocklist at ${path}: missing entries[]`);
  }
  return parsed;
}

/** Lowercased hostname of a candidate URL, or null when it cannot be parsed. */
export function domainOf(resourceUrl: string): string | null {
  try {
    return new URL(resourceUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Return the blocklist entry that matches the URL's host — exact host or any
 * subdomain of a blocklisted domain — or null when the domain is allowed.
 */
export function blocklistEntryFor(
  resourceUrl: string,
  blocklist: ProviderBlocklist,
): ProviderBlocklistEntry | null {
  const host = domainOf(resourceUrl);
  if (!host) return null;
  for (const entry of blocklist.entries) {
    const domain = entry.domain.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) return entry;
  }
  return null;
}

export function isDomainBlocklisted(resourceUrl: string, blocklist: ProviderBlocklist): boolean {
  return blocklistEntryFor(resourceUrl, blocklist) !== null;
}

export interface BlocklistSkip<T> {
  readonly item: T;
  readonly entry: ProviderBlocklistEntry;
}

export interface BlocklistPartition<T> {
  readonly allowed: readonly T[];
  readonly skipped: readonly BlocklistSkip<T>[];
}

/**
 * Split candidates into those whose domain is allowed and those excluded by the
 * blocklist. Order within each group is preserved so ranking stays stable.
 */
export function partitionByBlocklist<T>(
  candidates: readonly T[],
  blocklist: ProviderBlocklist,
  getUrl: (item: T) => string,
): BlocklistPartition<T> {
  const allowed: T[] = [];
  const skipped: BlocklistSkip<T>[] = [];
  for (const item of candidates) {
    const entry = blocklistEntryFor(getUrl(item), blocklist);
    if (entry) skipped.push({ item, entry });
    else allowed.push(item);
  }
  return { allowed, skipped };
}

/** Human-readable reason string recorded on a skipped candidate. */
export function blocklistSkipReason(entry: ProviderBlocklistEntry): string {
  return `${SKIPPED_BLOCKLISTED}: ${entry.domain} (${entry.reason})`;
}

/**
 * Return the watch entry matching the URL's host (exact host or subdomain), or
 * null. Watch membership never excludes a candidate — this is for surfacing the
 * correlation only, so it is deliberately kept out of the blocklist predicates.
 */
export function watchEntryFor(
  resourceUrl: string,
  blocklist: ProviderBlocklist,
): ProviderWatchEntry | null {
  const host = domainOf(resourceUrl);
  if (!host) return null;
  for (const entry of blocklist.watch ?? []) {
    const domain = entry.domain.toLowerCase();
    if (host === domain || host.endsWith(`.${domain}`)) return entry;
  }
  return null;
}

export function isDomainWatched(resourceUrl: string, blocklist: ProviderBlocklist): boolean {
  return watchEntryFor(resourceUrl, blocklist) !== null;
}
