/**
 * extract-tx-explainer-claims — deterministic claim extraction (no LLM judge).
 */

import type { TxGroundTruth } from "./build-tx-ground-truth";

export const CLAIM_EXTRACTION_VERSION = "0.1.0";

export interface TxExplainerClaims {
  readonly claim_extraction_version: string;
  readonly tx_hash_claims: readonly string[];
  readonly chain_claims: readonly string[];
  readonly status_claims: readonly string[];
  readonly block_number_claims: readonly number[];
  readonly address_claims: readonly string[];
  readonly token_transfer_claims: readonly {
    readonly token?: string;
    readonly symbol?: string;
    readonly from?: string;
    readonly to?: string;
    readonly amount?: string;
  }[];
  readonly amount_claims: readonly string[];
  readonly fee_claims: readonly string[];
  readonly logs_count_claims: readonly number[];
  readonly unsupported_claims: readonly string[];
  readonly raw_claim_count: number;
}

const TX_HASH_RE = /\b0x[0-9a-fA-F]{64}\b/g;
const ADDRESS_RE = /\b0x[0-9a-fA-F]{40}\b/g;
const AMOUNT_RE = /\b\d+(?:\.\d{1,18})?\s*(?:USDC|usdc|USD)\b/gi;
const BLOCK_RE = /\bblock(?:\s*(?:number|#))?\s*[:#]?\s*(\d+)\b/gi;
const CHAIN_RE =
  /\b(?:chain(?:\s*id)?|network)\s*[:=]?\s*(8453|1|base|ethereum|eip155:8453|eip155:1)\b/gi;
const STATUS_RE = /\b(success(?:ful)?|reverted|failed|confirmed)\b/gi;
const LOGS_RE = /\b(\d+)\s+logs?\b/gi;
const GAS_RE = /\b(?:gas(?:\s*used)?|fee)\s*[:=]?\s*(0x[0-9a-fA-F]+|\d+)\b/gi;

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function collectRegexMatches(text: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(re)) {
    out.push(match[0]);
  }
  return out;
}

function walkJson(value: unknown, visit: (path: string, value: unknown) => void, path = ""): void {
  visit(path, value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJson(item, visit, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      walkJson(nested, visit, path ? `${path}.${key}` : key);
    }
  }
}

function normalizeStatus(value: string): string {
  const lower = value.toLowerCase();
  if (lower.includes("success") || lower.includes("confirmed")) return "success";
  if (lower.includes("revert") || lower.includes("fail")) return "reverted";
  return lower;
}

function parseChainClaim(value: unknown): string | null {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "base" || trimmed === "eip155:8453") return "8453";
  if (trimmed === "ethereum" || trimmed === "eip155:1") return "1";
  if (/^\d+$/.test(trimmed)) return trimmed;
  return trimmed;
}

function firstTransactionDetailsRecord(
  dataRecord?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = dataRecord?.transactionDetailsV2;
  if (Array.isArray(raw)) {
    const first = raw[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : undefined;
  }
  if (raw && typeof raw === "object") {
    return raw as Record<string, unknown>;
  }
  return undefined;
}

function extractZapperTokenDeltas(
  details: Record<string, unknown>,
): TxExplainerClaims["token_transfer_claims"][number][] {
  const out: TxExplainerClaims["token_transfer_claims"][number][] = [];
  const deltas = details.deltas as { readonly edges?: readonly unknown[] } | undefined;
  if (!Array.isArray(deltas?.edges)) return out;

  for (const edge of deltas.edges) {
    if (!edge || typeof edge !== "object") continue;
    const node = (edge as { readonly node?: Record<string, unknown> }).node;
    if (!node || typeof node !== "object") continue;
    const accountAddress =
      typeof node.account === "object" && node.account
        ? (node.account as Record<string, unknown>).address
        : undefined;
    const tokenEdges = (
      node.tokenDeltasV2 as { readonly edges?: readonly unknown[] } | undefined
    )?.edges;
    if (!Array.isArray(tokenEdges)) continue;
    for (const tokenEdge of tokenEdges) {
      if (!tokenEdge || typeof tokenEdge !== "object") continue;
      const tokenNode = (tokenEdge as { readonly node?: Record<string, unknown> }).node;
      const token =
        tokenNode && typeof tokenNode.token === "object" && tokenNode.token
          ? (tokenNode.token as Record<string, unknown>).address
          : undefined;
      out.push({
        token: typeof token === "string" ? token.toLowerCase() : undefined,
        symbol: "USDC",
        from: typeof accountAddress === "string" ? accountAddress.toLowerCase() : undefined,
      });
    }
  }
  return out;
}

function extractFromStructured(body: unknown): Partial<TxExplainerClaims> {
  const tx_hash_claims: string[] = [];
  const chain_claims: string[] = [];
  const status_claims: string[] = [];
  const block_number_claims: number[] = [];
  const address_claims: string[] = [];
  const token_transfer_claims: TxExplainerClaims["token_transfer_claims"][number][] = [];
  const amount_claims: string[] = [];
  const fee_claims: string[] = [];
  const logs_count_claims: number[] = [];

  walkJson(body, (_path, value) => {
    if (typeof value === "string") {
      if (/^0x[0-9a-fA-F]{64}$/.test(value)) tx_hash_claims.push(value.toLowerCase());
      if (/^0x[0-9a-fA-F]{40}$/.test(value)) address_claims.push(value.toLowerCase());
    }
  });

  const record = body as Record<string, unknown>;
  const dataRecord =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : undefined;
  const details = firstTransactionDetailsRecord(dataRecord) ??
    (record.transactionDetailsV2 && typeof record.transactionDetailsV2 === "object"
      ? firstTransactionDetailsRecord({ transactionDetailsV2: record.transactionDetailsV2 })
      : undefined);
  const tx = (record.transaction as Record<string, unknown> | undefined) ??
    (details?.transaction as Record<string, unknown> | undefined);

  if (tx && typeof tx === "object") {
    const txRecord = tx as Record<string, unknown>;
    if (typeof txRecord.hash === "string") tx_hash_claims.push(txRecord.hash.toLowerCase());
    if (typeof txRecord.blockNumber === "number") block_number_claims.push(txRecord.blockNumber);
    if (typeof txRecord.fromUser === "object" && txRecord.fromUser) {
      const from = (txRecord.fromUser as Record<string, unknown>).address;
      if (typeof from === "string") address_claims.push(from.toLowerCase());
    }
    if (typeof txRecord.toUser === "object" && txRecord.toUser) {
      const to = (txRecord.toUser as Record<string, unknown>).address;
      if (typeof to === "string") address_claims.push(to.toLowerCase());
    }
  }

  for (const key of ["chainId", "chain_id", "network", "chain"]) {
    const parsed = parseChainClaim(record[key]);
    if (parsed) chain_claims.push(parsed);
  }

  if (typeof record.status === "string") status_claims.push(normalizeStatus(record.status));
  if (typeof record.block_number === "number") block_number_claims.push(record.block_number);
  if (typeof record.logs_count === "number") logs_count_claims.push(record.logs_count);

  const transfers = record.erc20_transfers ?? record.transfers ?? record.token_transfers;
  if (Array.isArray(transfers)) {
    for (const item of transfers) {
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      token_transfer_claims.push({
        token: typeof t.token === "string" ? t.token.toLowerCase() : undefined,
        symbol: typeof t.symbol === "string" ? t.symbol : undefined,
        from: typeof t.from === "string" ? t.from.toLowerCase() : undefined,
        to: typeof t.to === "string" ? t.to.toLowerCase() : undefined,
        amount:
          typeof t.amount_decimal === "string"
            ? t.amount_decimal
            : typeof t.amount === "string"
              ? t.amount
              : undefined,
      });
      if (typeof t.amount_decimal === "string") amount_claims.push(t.amount_decimal);
    }
  }

  if (details) {
    token_transfer_claims.push(...extractZapperTokenDeltas(details));
  }

  return {
    tx_hash_claims: unique(tx_hash_claims.map((v) => v.toLowerCase())),
    chain_claims: unique(chain_claims),
    status_claims: unique(status_claims.map(normalizeStatus)),
    block_number_claims: unique(block_number_claims),
    address_claims: unique(address_claims.map((v) => v.toLowerCase())),
    token_transfer_claims,
    amount_claims: unique(amount_claims),
    fee_claims: unique(fee_claims),
    logs_count_claims: unique(logs_count_claims),
  };
}

function extractFromText(text: string): Partial<TxExplainerClaims> {
  const tx_hash_claims = unique(
    (text.match(TX_HASH_RE) ?? []).map((v) => v.toLowerCase()),
  );
  const address_claims = unique(
    (text.match(ADDRESS_RE) ?? []).map((v) => v.toLowerCase()),
  );
  const amount_claims = unique(text.match(AMOUNT_RE) ?? []);
  const chain_claims = unique(
    collectRegexMatches(text, CHAIN_RE).map((v) => {
      const lower = v.toLowerCase();
      if (lower.includes("8453") || lower.includes("base")) return "8453";
      if (lower.includes("ethereum") || /\b1\b/.test(lower)) return "1";
      return lower.replace(/.*[:=]\s*/, "");
    }),
  );
  const status_claims = unique(
    (text.match(STATUS_RE) ?? []).map(normalizeStatus),
  );
  const block_number_claims = unique(
    [...text.matchAll(BLOCK_RE)].map((m) => Number.parseInt(m[1] ?? "0", 10)).filter((n) => n > 0),
  );
  const logs_count_claims = unique(
    [...text.matchAll(LOGS_RE)].map((m) => Number.parseInt(m[1] ?? "0", 10)).filter((n) => n >= 0),
  );
  const fee_claims = unique(collectRegexMatches(text, GAS_RE));

  return {
    tx_hash_claims,
    chain_claims,
    status_claims,
    block_number_claims,
    address_claims,
    amount_claims,
    fee_claims,
    logs_count_claims,
    token_transfer_claims: [],
  };
}

export function extractTxExplainerClaims(input: {
  readonly body: unknown;
  readonly contentType?: string;
  readonly expectedChainId?: number;
}): TxExplainerClaims {
  let structured: Partial<TxExplainerClaims> = {};
  let text = "";
  let structuredObject = false;

  if (typeof input.body === "string") {
    text = input.body;
    try {
      const parsed = JSON.parse(input.body);
      structuredObject = parsed && typeof parsed === "object";
      structured = extractFromStructured(parsed);
    } catch {
      structured = extractFromText(input.body);
    }
  } else if (input.body && typeof input.body === "object") {
    structuredObject = true;
    structured = extractFromStructured(input.body);
    text = JSON.stringify(input.body);
  } else if (input.body != null) {
    text = String(input.body);
    structured = extractFromText(text);
  }

  if (input.expectedChainId != null) {
    structured.chain_claims = unique([
      ...(structured.chain_claims ?? []),
      String(input.expectedChainId),
    ]);
  }

  const prose = structuredObject ? extractFromText(text) : extractFromText(text);
  const merged: TxExplainerClaims = {
    claim_extraction_version: CLAIM_EXTRACTION_VERSION,
    tx_hash_claims: unique([
      ...(structured.tx_hash_claims ?? []),
      ...(prose.tx_hash_claims ?? []),
    ]),
    chain_claims: unique([...(structured.chain_claims ?? []), ...(prose.chain_claims ?? [])]),
    status_claims: unique([...(structured.status_claims ?? []), ...(prose.status_claims ?? [])]),
    block_number_claims: unique([
      ...(structured.block_number_claims ?? []),
      ...(structuredObject ? [] : (prose.block_number_claims ?? [])),
    ]),
    address_claims: unique([
      ...(structured.address_claims ?? []),
      ...(prose.address_claims ?? []),
    ]),
    token_transfer_claims: structured.token_transfer_claims ?? [],
    amount_claims: unique([
      ...(structured.amount_claims ?? []),
      ...(structuredObject ? [] : (prose.amount_claims ?? [])),
    ]),
    fee_claims: unique([...(structured.fee_claims ?? []), ...(prose.fee_claims ?? [])]),
    logs_count_claims: unique([
      ...(structured.logs_count_claims ?? []),
      ...(prose.logs_count_claims ?? []),
    ]),
    unsupported_claims: [],
    raw_claim_count: 0,
  };

  const raw_claim_count =
    merged.tx_hash_claims.length +
    merged.chain_claims.length +
    merged.status_claims.length +
    merged.block_number_claims.length +
    merged.address_claims.length +
    merged.token_transfer_claims.length +
    merged.amount_claims.length +
    merged.fee_claims.length +
    merged.logs_count_claims.length;

  return { ...merged, raw_claim_count };
}

export function claimsFromGroundTruth(groundTruth: TxGroundTruth): TxExplainerClaims {
  const usdc = groundTruth.erc20_transfers.find((t) => t.symbol === "USDC");
  return extractTxExplainerClaims({
    body: {
      tx_hash: groundTruth.tx_hash,
      chain_id: groundTruth.chain_id,
      status: groundTruth.status,
      block_number: groundTruth.block_number,
      from: groundTruth.from,
      to: groundTruth.to,
      gas_used: groundTruth.gas_used,
      logs_count: groundTruth.logs_count,
      erc20_transfers: groundTruth.erc20_transfers,
      amount: usdc?.amount_decimal,
    },
  });
}
