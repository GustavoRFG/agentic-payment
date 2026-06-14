/**
 * rich-tx-explainer-discovery — offline/local discovery for tx_explainer endpoints.
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ZAPPER_TX_EXPLAINER_POLICY,
  type RichTxExplainerPolicy,
} from "./rich-tx-explainer-policy";
import { atomicUsdcToDecimal, compareUsdcDecimal } from "./external-x402-get-policy";

export type DiscoveryStatus = "FOUND_OATP" | "FOUND_EQUIVALENT" | "NOT_FOUND" | "PARTIAL";

export interface DiscoveryCandidate {
  readonly candidate_id: string;
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint_url: string;
  readonly method: "GET" | "POST";
  readonly description: string;
  readonly source: string;
  readonly observed_quote_usdc: string | null;
  readonly network: string | null;
  readonly asset: string | null;
  readonly accepts_tx_hash: boolean;
  readonly is_oatp: boolean;
  readonly policy_id: string | null;
  readonly within_cap: boolean | null;
}

export interface DiscoveryReport {
  readonly discovery_status: DiscoveryStatus;
  readonly oatp_found: boolean;
  readonly candidates: readonly DiscoveryCandidate[];
  readonly selected_policy_id: string | null;
  readonly selected_policy: RichTxExplainerPolicy | null;
  readonly gaps: readonly string[];
  readonly sources_searched: readonly string[];
}

const SEARCH_TERMS = [
  "oatp",
  "tx_explainer",
  "transaction explainer",
  "transaction-details",
  "explain transaction",
  "transaction analysis",
  "onchain explanation",
] as const;

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function trustforgeWorkspaceRoot(): string {
  return "D:\\trustforge";
}

function readJsonIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function matchesExplainer(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("tx_explainer") ||
    lower.includes("transaction explainer") ||
    lower.includes("transaction-details") ||
    (lower.includes("transaction") &&
      (lower.includes("interpret") ||
        lower.includes("explain") ||
        lower.includes("human-readable")))
  );
}

function parseBazaarCandidates(
  bazaarPath: string,
  capUsdc: string | null,
): DiscoveryCandidate[] {
  const raw = readJsonIfExists(bazaarPath);
  if (!raw || typeof raw !== "object") return [];
  const items = (raw as { items?: unknown[] }).items ?? [];
  const out: DiscoveryCandidate[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const resource = String(record.resource ?? "");
    const description = String(record.description ?? "");
    const blob = `${resource} ${description} ${JSON.stringify(record)}`;
    if (!matchesExplainer(blob)) continue;

    const accepts = Array.isArray(record.accepts) ? record.accepts : [];
    const first = accepts[0] as Record<string, unknown> | undefined;
    const amount = typeof first?.amount === "string" ? first.amount : null;
    const quote = amount ? atomicUsdcToDecimal(amount) : null;
    const network = typeof first?.network === "string" ? first.network : null;
    const isOatp = blob.toLowerCase().includes("oatp");
    const isZapper = resource.includes("zapper.xyz/x402/transaction-details");
    const method =
      JSON.stringify(record).includes('"method":"POST"') ||
      description.toLowerCase().includes("post")
        ? "POST"
        : "GET";

    out.push({
      candidate_id: resource.replace(/[^a-z0-9]+/gi, "_").slice(0, 64),
      provider: isZapper ? "Zapper" : String(record.serviceName ?? "unknown"),
      service_id: isZapper ? "zapper_tx_explainer" : "unknown_tx_explainer",
      endpoint_url: resource,
      method,
      description,
      source: bazaarPath,
      observed_quote_usdc: quote,
      network,
      asset: "USDC",
      accepts_tx_hash: blob.toLowerCase().includes("hash"),
      is_oatp: isOatp,
      policy_id: isZapper ? ZAPPER_TX_EXPLAINER_POLICY.policyId : null,
      within_cap:
        quote && capUsdc ? compareUsdcDecimal(quote, capUsdc) <= 0 : null,
    });
  }

  return out;
}

export function discoverRichTxExplainerEndpoints(options: {
  readonly capUsdc?: string | null;
  readonly repoRoot?: string;
  readonly workspaceRoot?: string;
} = {}): DiscoveryReport {
  const root = options.repoRoot ?? repoRoot();
  const workspace = options.workspaceRoot ?? trustforgeWorkspaceRoot();
  const capUsdc = options.capUsdc ?? null;
  const sources_searched: string[] = [];
  const gaps: string[] = [];
  const candidates: DiscoveryCandidate[] = [];

  const paths = [
    join(workspace, "artifacts", "runs", "spike-zero", "run_20260611_015536", "evidence", "public_sources", "cdp_bazaar_resources_body.json"),
    join(root, "trustforge", "tasks", "oatp_tx_explainer", "tx_explainer_v0_draft.json"),
    join(root, "trustforge", "registry", "services.bootstrap.json"),
    join(root, "docs", "trustforge-oatp-tx-explainer-plan.md"),
  ];

  for (const path of paths) {
    sources_searched.push(path);
    if (path.endsWith("cdp_bazaar_resources_body.json")) {
      candidates.push(...parseBazaarCandidates(path, capUsdc));
      continue;
    }
    if (path.endsWith("tx_explainer_v0_draft.json")) {
      const draft = readJsonIfExists(path) as Record<string, unknown> | null;
      if (draft?.status === "draft_unpaid_only") {
        gaps.push("OATP draft task exists but endpoint is REPLACE-WITH placeholder");
      }
    }
  }

  const oatp_found = candidates.some((c) => c.is_oatp);
  const zapper = candidates.find((c) => c.policy_id === ZAPPER_TX_EXPLAINER_POLICY.policyId);

  let discovery_status: DiscoveryStatus = "NOT_FOUND";
  let selected_policy: RichTxExplainerPolicy | null = null;
  let selected_policy_id: string | null = null;

  if (oatp_found) {
    discovery_status = "FOUND_OATP";
  } else if (zapper) {
    discovery_status = "FOUND_EQUIVALENT";
    selected_policy = ZAPPER_TX_EXPLAINER_POLICY;
    selected_policy_id = ZAPPER_TX_EXPLAINER_POLICY.policyId;
    if (capUsdc) {
      selected_policy = {
        ...selected_policy,
        maxPricePerCallUsdc: capUsdc,
        maxTotalSpendUsdc: capUsdc,
      };
    }
  } else if (candidates.length > 0) {
    discovery_status = "PARTIAL";
    gaps.push("Candidates found but none allowlisted for paid probe");
  } else {
    gaps.push("No OATP or tx_explainer x402 endpoint in local registry/Bazaar cache");
  }

  if (!oatp_found) {
    gaps.push("OATP not present in CDP Bazaar cache snapshot");
  }

  return {
    discovery_status,
    oatp_found,
    candidates,
    selected_policy_id,
    selected_policy,
    gaps,
    sources_searched,
  };
}
