import type { DefiGuardianReportMode } from "./reportTypes";

export interface DefiGuardianAdapterConfig {
  mode: DefiGuardianReportMode;
  snapshotPath: string | null;
  cliCommand: string | null;
  warnings: string[];
}

function modeFromEnv(value: string | undefined): {
  mode: DefiGuardianReportMode;
  warning?: string;
} {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "mock" || normalized === "adapter-mock") {
    return { mode: "adapter-mock" };
  }
  if (
    normalized === "real-file" ||
    normalized === "file" ||
    normalized === "adapter-real-file"
  ) {
    return { mode: "adapter-real-file" };
  }
  if (
    normalized === "real-cli" ||
    normalized === "cli" ||
    normalized === "adapter-real-cli"
  ) {
    return { mode: "adapter-real-cli" };
  }
  return {
    mode: "adapter-mock",
    warning:
      `Unsupported DEFI_GUARDIAN_ADAPTER_MODE "${value}". ` +
      "Falling back to adapter-mock.",
  };
}

function optionalEnv(value: string | undefined): string | null {
  const normalized = (value ?? "").trim();
  return normalized.length > 0 ? normalized : null;
}

export function getDefiGuardianAdapterConfig(
  env: NodeJS.ProcessEnv = process.env,
): DefiGuardianAdapterConfig {
  const resolved = modeFromEnv(env.DEFI_GUARDIAN_ADAPTER_MODE);
  const warnings = resolved.warning ? [resolved.warning] : [];
  return {
    mode: resolved.mode,
    snapshotPath: optionalEnv(env.DEFI_GUARDIAN_SNAPSHOT_PATH),
    cliCommand: optionalEnv(env.DEFI_GUARDIAN_CLI_COMMAND),
    warnings,
  };
}
