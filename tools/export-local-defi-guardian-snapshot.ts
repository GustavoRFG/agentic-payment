import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local-only wrapper: run the DeFi Guardian read-only exporter and write a
 * sanitized `defi-guardian-snapshot-v1` JSON into this repo's gitignored
 * `runtime/` directory.
 *
 * This wrapper never reads `.env`, never prints secrets, and never executes any
 * blockchain transaction. It only shells out to the DeFi Guardian package
 * script `export:agentic-snapshot`, which is read-only by construction.
 *
 * The DeFi Guardian location is configurable via `DEFI_GUARDIAN_ROOT`
 * (Windows default: `D:\defi_guardian`).
 */
function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function defiGuardianRoot(): string {
  const fromEnv = process.env.DEFI_GUARDIAN_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv.trim());
  return process.platform === "win32" ? "D:\\defi_guardian" : resolve(projectRoot(), "..", "defi_guardian");
}

function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function main(): void {
  const root = projectRoot();
  const guardianRoot = defiGuardianRoot();
  const outputPath = resolve(root, "runtime", "defi-guardian-snapshots", "latest.json");
  const passthrough = process.argv.slice(2);

  const args = [
    "--prefix",
    guardianRoot,
    "run",
    "export:agentic-snapshot",
    "--",
    "--output",
    outputPath,
    ...passthrough,
  ];

  console.log(`Exporting sanitized snapshot from DeFi Guardian: ${guardianRoot}`);
  console.log(`Output (gitignored): ${outputPath}`);

  const spawnArgs =
    process.platform === "win32"
      ? (["cmd.exe", ["/d", "/s", "/c", npmCommand(), ...args]] as const)
      : ([npmCommand(), args] as const);

  const child = spawn(spawnArgs[0], spawnArgs[1] as string[], {
    cwd: guardianRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  child.on("error", (error) => {
    console.error(`Exporter failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = code ?? 1;
  });
}

main();
