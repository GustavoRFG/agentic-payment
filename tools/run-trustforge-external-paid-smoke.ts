import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV,
  defaultExternalPaidReadinessRunDir,
  requestFromPaidPolicy,
  runExternalPaidProbe,
  writeExternalPaidReadinessArtifacts,
  type ExternalPaidExecutionRequest,
  type ExternalPaidProbeMode,
} from "./trustforge/external-x402-paid-executor";
import {
  livePaidDependencies,
  liveReadinessDependencies,
} from "./trustforge/external-x402-live-bindings";
import {
  resolveExternalX402GetProbePolicy,
} from "./trustforge/external-x402-get-policy";

interface CliArgs {
  policyId: string;
  runDir?: string;
  runId?: string;
  readinessOnly: boolean;
  executePaid: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    policyId: "",
    readinessOnly: false,
    executePaid: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--policy") {
      args.policyId = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--run-dir") {
      args.runDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--run-id") {
      args.runId = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--readiness-only") {
      args.readinessOnly = true;
      continue;
    }
    if (arg === "--execute-paid") {
      args.executePaid = true;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  if (!args.policyId) {
    throw new Error("missing required --policy <policy_id>");
  }
  if (!args.readinessOnly && !args.executePaid) {
    throw new Error("must pass --readiness-only or --execute-paid");
  }
  if (args.readinessOnly && args.executePaid) {
    throw new Error("--readiness-only cannot be combined with --execute-paid");
  }
  return args;
}

export function modeFromArgs(args: CliArgs): ExternalPaidProbeMode {
  return args.executePaid ? "execute-paid" : "readiness-only";
}

export function requestFromArgs(args: CliArgs): ExternalPaidExecutionRequest {
  const policy = resolveExternalX402GetProbePolicy(args.policyId);
  return requestFromPaidPolicy(policy, {
    readinessOnly: args.readinessOnly,
    executePaid: args.executePaid,
    runId: args.runId,
    armingEnvValue: process.env[TRUSTFORGE_EXTERNAL_PAID_ARMING_ENV],
  });
}

export function dependenciesForMode(mode: ExternalPaidProbeMode) {
  return mode === "readiness-only"
    ? liveReadinessDependencies()
    : livePaidDependencies();
}

export async function main(): Promise<number> {
  let runDir = defaultExternalPaidReadinessRunDir();
  try {
    const args = parseArgs(process.argv.slice(2));
    runDir = args.runDir ?? runDir;
    const policy = resolveExternalX402GetProbePolicy(args.policyId);
    const request = requestFromArgs(args);
    const mode = modeFromArgs(args);
    const result = await runExternalPaidProbe(
      {
        policy,
        request,
        mode,
      },
      dependenciesForMode(mode),
    );
    await writeExternalPaidReadinessArtifacts(runDir, policy, result);

    console.log(`RESULT: ${result.status === "PASS" ? "PASS" : "FAIL"}`);
    console.log(`status: ${result.status}`);
    console.log(`scratch_dir: ${runDir}`);
    console.log(`policy_id: ${policy.policyId}`);
    console.log(`target_endpoint: ${policy.exactUrl}`);
    console.log(`terminal_state: ${result.terminalState}`);
    console.log(`http_status: ${result.handshake?.httpStatus ?? "null"}`);
    console.log(`quote_usdc: ${result.handshake?.quoteUsdc ?? "null"}`);
    console.log(`network: ${result.handshake?.network ?? "null"}`);
    console.log(`asset: ${result.handshake?.asset ?? "null"}`);
    console.log(`report: ${join(runDir, "14_paid_smoke_report.md")}`);
    console.log(
      `wallet_load_started: ${result.walletLoadStarted ? "yes" : "no"}`,
    );
    console.log(`payment_attempted: ${result.paymentAttempted ? "yes" : "no"}`);
    console.log(`payment_attempts: ${result.paymentAttempts}`);
    console.log("wallet_used: no");
    console.log("settlement_attempted: no");
    console.log("payment_headers_sent_live: no");
    console.log(`readiness_only: ${args.readinessOnly ? "yes" : "no"}`);
    if (result.error) {
      console.log(`error: ${result.error}`);
    }
    return result.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(`[trustforge-external-paid-smoke] error: ${(error as Error).message}`);
    console.log("RESULT: FAIL");
    console.log(`scratch_dir: ${runDir}`);
    console.log("payment_attempted: no");
    console.log("payment_attempts: 0");
    console.log("wallet_used: no");
    console.log("settlement_attempted: no");
    console.log("payment_headers_sent_live: no");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error("[trustforge-external-paid-smoke] fatal:", (error as Error).message);
      process.exitCode = 1;
    });
}
