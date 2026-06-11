import { join } from "node:path";
import {
  defaultExternalProbeRunDir,
  inspectExternalX402GetHandshake,
  writeExternalProbeFailureArtifacts,
  writeExternalProbePreflightArtifacts,
} from "./trustforge/external-x402-get-adapter";
import {
  resolveExternalX402GetProbePolicy,
} from "./trustforge/external-x402-get-policy";

interface CliArgs {
  policyId: string;
  runDir?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let policyId = "";
  let runDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy") {
      policyId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--run-dir") {
      runDir = argv[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!policyId) {
    throw new Error("missing required --policy <policy_id>");
  }
  return { policyId, runDir };
}

async function main(): Promise<number> {
  let policyId = "";
  let runDir = defaultExternalProbeRunDir();

  try {
    const args = parseArgs(process.argv.slice(2));
    policyId = args.policyId;
    runDir = args.runDir ?? runDir;
  } catch (error) {
    console.error(`[trustforge-external-dry-run] error: ${(error as Error).message}`);
    console.log("RESULT: FAIL");
    console.log("payment_attempted: no");
    console.log("wallet_used: no");
    console.log("dry_run_only: yes");
    return 1;
  }

  const policy = resolveExternalX402GetProbePolicy(policyId);

  try {
    const inspection = await inspectExternalX402GetHandshake(policy);
    await writeExternalProbePreflightArtifacts(runDir, policy, inspection);
    console.log("RESULT: PASS");
    console.log(`scratch_dir: ${runDir}`);
    console.log(`policy_id: ${policy.policyId}`);
    console.log(`target_endpoint: ${policy.exactUrl}`);
    console.log(`http_status: ${inspection.httpStatus}`);
    console.log(`x402_version: ${inspection.x402VersionObserved ?? "unknown"}`);
    console.log(`quote_usdc: ${inspection.quoteUsdc}`);
    console.log(`network: ${inspection.network}`);
    console.log(`asset: ${inspection.asset}`);
    console.log(`report: ${join(runDir, "07_preflight_report.md")}`);
    console.log("payment_attempted: no");
    console.log("wallet_used: no");
    console.log("dry_run_only: yes");
    return 0;
  } catch (error) {
    await writeExternalProbeFailureArtifacts(runDir, policy, error);
    console.error(`[trustforge-external-dry-run] error: ${(error as Error).message}`);
    console.log("RESULT: FAIL");
    console.log(`scratch_dir: ${runDir}`);
    console.log(`policy_id: ${policy.policyId}`);
    console.log(`target_endpoint: ${policy.exactUrl}`);
    console.log(`report: ${join(runDir, "07_preflight_report.md")}`);
    console.log("payment_attempted: no");
    console.log("wallet_used: no");
    console.log("dry_run_only: yes");
    return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error("[trustforge-external-dry-run] fatal:", (error as Error).message);
    process.exitCode = 1;
  });
