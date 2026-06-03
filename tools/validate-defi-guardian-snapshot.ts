import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  forbiddenSnapshotPath,
  parseDefiGuardianSnapshotV1Json,
} from "../seller-api/src/adapters/defi-guardian/defiGuardianSnapshotV1.ts";

function projectRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function parseArgs(argv: string[]): { file: string | null } {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--file") {
      const file = argv[index + 1];
      return { file: file ? resolve(projectRoot(), file) : null };
    }
  }
  return { file: null };
}

function printInvalid(errors: string[], secretsDetected: boolean): void {
  console.log("RESULT: SNAPSHOT_INVALID");
  console.log(`Secrets detected: ${secretsDetected ? "Yes" : "No"}`);
  console.log("Errors:");
  for (const error of errors) console.log(`- ${error}`);
}

function main(): number {
  const { file } = parseArgs(process.argv.slice(2));
  if (file === null) {
    printInvalid(["Missing --file path."], false);
    return 1;
  }

  const forbidden = forbiddenSnapshotPath(file);
  if (forbidden !== null) {
    printInvalid([forbidden], false);
    return 1;
  }
  if (!existsSync(file)) {
    printInvalid([`Snapshot file does not exist: ${file}`], false);
    return 1;
  }

  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    printInvalid([`Unable to read snapshot file: ${message}`], false);
    return 1;
  }

  const result = parseDefiGuardianSnapshotV1Json(raw);
  if (!result.ok) {
    printInvalid(result.errors, result.secretsDetected);
    return 1;
  }

  console.log("RESULT: SNAPSHOT_VALID");
  console.log(`Version: ${result.snapshot.snapshotVersion}`);
  console.log(`Positions: ${result.snapshot.positions.length}`);
  console.log("Token IDs:");
  for (const tokenId of result.tokenIds) console.log(`- ${tokenId}`);
  console.log("Secrets detected: No");
  return 0;
}

process.exitCode = main();
