/**
 * provider-blocklist — evidence-backed exclusion of x402 provider domains.
 *
 * Domains recorded in config/x402_provider_blocklist.json are dropped from
 * discovery/adapt BEFORE ranking, each drop recorded as SKIPPED_BLOCKLISTED in
 * the candidate evidence. Entries are added by evidence and removed only by a
 * human editing the file — this module never mutates the blocklist.
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
}

export interface ProviderBlocklist {
  readonly schema_name?: string;
  readonly schema_version?: string;
  readonly note?: string;
  readonly entries: readonly ProviderBlocklistEntry[];
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
