/**
 * run-trustforge-phase5-rich-provider-discovery — Phase 5 unpaid provider discovery (no payment).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverRichTxExplainerEndpoints } from "./trustforge/rich-tx-explainer-discovery";
import { inspectRichTxExplainerUnpaidHandshake } from "./trustforge/rich-tx-explainer-handshake";
import {
  applyCapToPolicy,
  PHASE2_FIXTURE_TX,
  ZAPPER_TX_EXPLAINER_POLICY,
} from "./trustforge/rich-tx-explainer-policy";
import { readJson, repoPath } from "./trustforge/contracts";
import {
  candidateFromZapperDiscovery,
  candidateFromRegistryService,
  discoveryCandidateToRecord,
  finalizeCandidates,
  selectBestCandidate,
  buildHumanAuthorizationTemplate,
  type CandidateProviderRecord,
} from "./trustforge/rich-provider-discovery";
import { checkPhase3bEnvSafety } from "./run-trustforge-rich-tx-explainer-phase3b";

const WORKSPACE = "D:\\trustforge";
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function timestampDir(date = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    "_",
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join("");
}

function gitHash(): string {
  try {
    return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function gitBranch(): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: REPO, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(path: string, value: string): Promise<void> {
  await writeFile(path, value, "utf8");
}

export interface Phase5DiscoveryResult {
  readonly runDir: string;
  readonly status: string;
  readonly candidates: readonly CandidateProviderRecord[];
  readonly selected: ReturnType<typeof selectBestCandidate>;
  readonly unpaidLivenessStatus: "pass" | "fail" | "not_executed";
  readonly paymentBearingHttpRequestCount: 0;
}

export async function runPhase5RichProviderDiscovery(options: {
  readonly runDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetchImpl?: typeof fetch;
  readonly skipLiveHandshake?: boolean;
} = {}): Promise<Phase5DiscoveryResult> {
  const env = options.env ?? process.env;
  const commitBefore = gitHash();
  const runDir =
    options.runDir ??
    join(WORKSPACE, "artifacts", "runs", "phase5-rich-provider-discovery", `run_${timestampDir()}`);
  await mkdir(runDir, { recursive: true });

  const envSafety = checkPhase3bEnvSafety(env);
  if (envSafety.status !== "PASS_NO_PAYMENT_FLAGS") {
    throw new Error(`BLOCKED_UNSAFE_ENV: ${envSafety.status}`);
  }

  await writeJson(join(runDir, "01_run_state.json"), {
    phase: "phase5_rich_provider_discovery",
    status: "running",
    strict_no_payment: true,
    wallet_loaded: false,
    payment_header_sent: false,
    execute_paid_used: false,
    payment_attempted_live: false,
    payment_bearing_http_request_count: 0,
    new_transaction_hash_created: false,
    commit_before: commitBefore,
    commit_after: null,
  });

  const capUsdc = "0.10";
  const discovery = discoverRichTxExplainerEndpoints({ capUsdc });
  await writeJson(join(runDir, "02_offline_discovery.json"), discovery);

  let unpaidLivenessStatus: "pass" | "fail" | "not_executed" = "not_executed";
  let handshake = null;

  const policy = discovery.selected_policy
    ? applyCapToPolicy(discovery.selected_policy, capUsdc)
    : applyCapToPolicy(ZAPPER_TX_EXPLAINER_POLICY, capUsdc);

  if (!options.skipLiveHandshake) {
    try {
      handshake = await inspectRichTxExplainerUnpaidHandshake(policy, {
        txHash: PHASE2_FIXTURE_TX,
        fetchImpl: options.fetchImpl,
      });
      unpaidLivenessStatus = "pass";
      await writeJson(join(runDir, "03_unpaid_liveness_handshake.json"), handshake);
    } catch (error) {
      unpaidLivenessStatus = "fail";
      await writeText(
        join(runDir, "03_unpaid_liveness_handshake.json"),
        JSON.stringify(
          {
            status: "fail",
            error: error instanceof Error ? error.message : String(error),
            wallet_used: false,
            payment_attempted: false,
          },
          null,
          2,
        ),
      );
    }
  }

  const candidates: CandidateProviderRecord[] = [];

  candidates.push(
    candidateFromZapperDiscovery({
      discovery,
      handshake,
      unpaidLivenessStatus,
    }),
  );

  for (const dc of discovery.candidates) {
    if (dc.service_id === "zapper_tx_explainer") continue;
    candidates.push(discoveryCandidateToRecord(dc));
  }

  const registry = readJson(repoPath("trustforge", "registry", "services.bootstrap.json")) as {
    services: Array<{
      service_id: string;
      provider: string;
      endpoint_url: string;
      category?: string;
      last_observed_quote_usdc?: string;
      status?: string;
      ground_truth_determinism?: string;
    }>;
  };

  for (const service of registry.services) {
    if (service.service_id === "zapper_tx_explainer") continue;
    candidates.push(candidateFromRegistryService(service));
  }

  const finalized = finalizeCandidates(candidates);
  for (const c of finalized) {
    const slug = c.service_id.replace(/[^a-z0-9_]+/gi, "_");
    await writeJson(join(runDir, `candidate_provider_${slug}.json`), c);
  }

  const selected = selectBestCandidate(finalized);
  if (selected) {
    await writeJson(join(runDir, "selected_candidate.json"), selected);
    await writeText(
      join(runDir, "selected_candidate.md"),
      [
        `# Selected rich probe candidate`,
        ``,
        `- **Provider:** ${selected.provider}`,
        `- **Service ID:** ${selected.service_id}`,
        `- **Endpoint:** ${selected.endpoint}`,
        `- **Observed quote:** ${selected.quote_amount_usdc} USDC`,
        `- **Recommended cap:** ${selected.recommended_max_usdc} USDC`,
        ``,
        `## Selection criteria`,
        ...Object.entries(selected.selection_criteria_met).map(
          ([k, v]) => `- ${k}: ${v ? "yes" : "no"}`,
        ),
        ``,
        `## Rationale`,
        ...selected.selection_rationale.map((r) => `- ${r}`),
      ].join("\n"),
    );
    await writeJson(
      join(runDir, "human_payment_authorization_template.json"),
      buildHumanAuthorizationTemplate(selected),
    );
  }

  const summary = {
    phase: "phase5_rich_provider_discovery",
    status: selected ? "WAITING_FOR_HUMAN_PAYMENT_DECISION" : "COMPLETED_NO_SAFE_PROVIDER_CANDIDATE",
    strict_no_payment: true,
    providers_discovered: finalized.length,
    candidates: finalized.map((c) => ({
      provider: c.provider,
      service_id: c.service_id,
      selection_score: c.selection_score,
      recommended: c.recommended,
      unpaid_liveness_status: c.unpaid_liveness_status,
    })),
    selected_candidate: selected,
    unpaid_liveness_status: unpaidLivenessStatus,
    discovery_status: discovery.discovery_status,
    payment_bearing_http_request_count: 0,
    commit_before: commitBefore,
  };

  await writeJson(join(runDir, "provider_discovery_summary.json"), summary);
  await writeText(
    join(runDir, "provider_discovery_summary.md"),
    [
      `# Phase 5 rich provider discovery`,
      ``,
      `Status: **${summary.status}**`,
      `Discovery: ${discovery.discovery_status}`,
      `Unpaid liveness (Zapper): ${unpaidLivenessStatus}`,
      `Candidates evaluated: ${finalized.length}`,
      ``,
      `## Ranked candidates`,
      ...finalized.map(
        (c, i) =>
          `${i + 1}. **${c.provider}** / \`${c.service_id}\` — score ${c.selection_score}, liveness ${c.unpaid_liveness_status ?? "n/a"}`,
      ),
      ``,
      selected
        ? `## Selected\n\n**${selected.provider}** (\`${selected.service_id}\`) at ${selected.quote_amount_usdc} USDC`
        : `## Selected\n\nNone — no candidate met all selection criteria`,
      ``,
      `Human authorization template: \`human_payment_authorization_template.json\` (decision=PENDING)`,
    ].join("\n"),
  );

  await writeJson(join(runDir, "01_run_state.json"), {
    ...summary,
    wallet_loaded: false,
    payment_header_sent: false,
    execute_paid_used: false,
    payment_attempted_live: false,
    new_transaction_hash_created: false,
    commit_after: gitHash(),
  });

  const phase5Status = selected
    ? "WAITING_FOR_HUMAN_PAYMENT_DECISION"
    : "COMPLETED_NO_SAFE_PROVIDER_CANDIDATE";

  const resultLines = selected
    ? [
        "RESULT",
        `trustforge_phase5_status: ${phase5Status}`,
        `repo: D:\\agentic-payments-lab`,
        `branch: ${gitBranch()}`,
        `commit_before: ${commitBefore}`,
        `commit_after: ${gitHash()}`,
        `commit_created: no`,
        `strict_no_payment: yes`,
        `wallet_loaded: no`,
        `payment_header_sent: no`,
        `execute_paid_used: no`,
        `payment_attempted_live: no`,
        `payment_bearing_http_request_count: 0`,
        `new_transaction_hash_created: no`,
        `providers_discovered: ${finalized.length}`,
        `selected_candidate: ${selected.service_id}`,
        `human_authorization_template: ${join(runDir, "human_payment_authorization_template.json")}`,
        `tests: pending`,
        `build: pending`,
        `contracts_validate: pending`,
        `invariants: pending`,
        `docs: docs/trustforge-phase5-rich-provider-discovery.md`,
        `report: ${join(runDir, "RESULT.txt")}`,
        "NEXT",
        "Review selected_candidate.json and create human_payment_authorization.json with decision=authorize_one_payment only if you want exactly one paid probe.",
      ]
    : [
        "RESULT",
        `trustforge_phase5_status: ${phase5Status}`,
        `strict_no_payment: yes`,
        `payment_attempted_live: no`,
        `recommended_next_step: Expand discovery sources or fix unpaid liveness before attempting Phase 6`,
      ];

  await writeText(join(runDir, "RESULT.txt"), `${resultLines.join("\n")}\n`);

  return {
    runDir,
    status: phase5Status,
    candidates: finalized,
    selected,
    unpaidLivenessStatus,
    paymentBearingHttpRequestCount: 0,
  };
}

async function main(): Promise<number> {
  process.env.TRUSTFORGE_PHASE4_NO_PAYMENT = "YES_STRICTLY_NO_PAYMENT";
  process.env.TRUSTFORGE_DISABLE_PAID_EXECUTION = "YES";

  const result = await runPhase5RichProviderDiscovery();
  console.log(JSON.stringify({
    status: result.status,
    runDir: result.runDir,
    selected: result.selected?.service_id ?? null,
    unpaidLiveness: result.unpaidLivenessStatus,
    candidates: result.candidates.length,
  }));
  return result.selected ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export { main as runPhase5Main };
