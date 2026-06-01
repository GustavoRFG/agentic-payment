import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export function projectRootFrom(metaUrl: string): string {
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

export function npmCommand(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function spawnNpm(
  args: string[],
  options: Parameters<typeof spawn>[2],
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", npmCommand(), ...args], options);
  }
  return spawn(npmCommand(), args, options);
}

export function tail(text: string, max = 2400): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

export function runCommand(
  label: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<CommandResult> {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawnNpm(args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      rejectCommand(new Error(`${label} failed to start: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolveCommand({ stdout, stderr });
        return;
      }
      rejectCommand(
        new Error(
          `${label} exited with code ${code ?? "unknown"}.\n${tail(stdout + stderr)}`,
        ),
      );
    });
  });
}
