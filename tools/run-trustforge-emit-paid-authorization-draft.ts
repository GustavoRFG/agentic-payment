/**
 * run-trustforge-emit-paid-authorization-draft — human-only authorization template writer.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DiscoveredSelectedCandidate } from "./trustforge/discovered-target-to-selected-candidate";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

export const PENDING_HUMAN_DECISION = "PENDING_HUMAN" as const;

export interface HumanPaymentAuthorizationDraft {
  readonly authorization_schema_version: "trustforge_paid_probe_authorization.v1";
  readonly decision: typeof PENDING_HUMAN_DECISION;
  readonly allowed_values: readonly ["reject", "authorize_one_payment"];
  readonly provider: string;
  readonly service_id: string;
  readonly endpoint: string;
  readonly network: string;
  readonly asset: string;
  readonly buyer_wallet: string;
  readonly max_usdc: string;
  readonly max_payment_attempts: 1;
  readonly allow_retry: false;
  readonly require_dedicated_wallet: true;
  readonly rationale: string;
  readonly decided_at: null;
  readonly target_selection_audit: DiscoveredSelectedCandidate["target_selection_audit"];
}

export function buildHumanPaymentAuthorizationDraft(
  candidate: DiscoveredSelectedCandidate,
): HumanPaymentAuthorizationDraft {
  return {
    authorization_schema_version: "trustforge_paid_probe_authorization.v1",
    decision: PENDING_HUMAN_DECISION,
    allowed_values: ["reject", "authorize_one_payment"],
    provider: candidate.provider,
    service_id: candidate.service_id,
    endpoint: candidate.endpoint,
    network: candidate.network,
    asset: candidate.asset,
    buyer_wallet: candidate.buyer_wallet,
    max_usdc: candidate.recommended_max_usdc,
    max_payment_attempts: 1,
    allow_retry: false,
    require_dedicated_wallet: true,
    rationale: "",
    decided_at: null,
    target_selection_audit: candidate.target_selection_audit,
  };
}

export function assertDraftDecisionIsPending(
  decision: string,
): asserts decision is typeof PENDING_HUMAN_DECISION {
  if (decision !== PENDING_HUMAN_DECISION) {
    throw new Error(
      `BLOCKED_AUTHORIZATION_DRAFT_DECISION: generator only writes decision=${PENDING_HUMAN_DECISION}`,
    );
  }
}

export async function writeHumanPaymentAuthorizationDraft(input: {
  readonly candidate: DiscoveredSelectedCandidate;
  readonly outputPath: string;
}): Promise<HumanPaymentAuthorizationDraft> {
  const draft = buildHumanPaymentAuthorizationDraft(input.candidate);
  assertDraftDecisionIsPending(draft.decision);
  await writeFile(input.outputPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
  return draft;
}

async function main(): Promise<number> {
  const selectedArg = process.argv.indexOf("--selected-candidate");
  const outputArg = process.argv.indexOf("--output");
  if (selectedArg < 0 || outputArg < 0) {
    console.error(
      "Usage: tsx tools/run-trustforge-emit-paid-authorization-draft.ts --selected-candidate <path> --output <path>",
    );
    return 1;
  }

  const selectedPath = process.argv[selectedArg + 1];
  const outputPath = process.argv[outputArg + 1];
  const candidate = JSON.parse(await readFile(selectedPath, "utf8")) as DiscoveredSelectedCandidate;
  await writeHumanPaymentAuthorizationDraft({ candidate, outputPath });
  console.log(`human_payment_authorization.DRAFT.json: ${outputPath}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

export { REPO as EMIT_PAID_AUTHORIZATION_DRAFT_REPO };
