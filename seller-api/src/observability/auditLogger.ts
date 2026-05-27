import { appendFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { SellerAuditEvent } from "./auditTypes";

function projectRoot(): string {
  const cwd = process.cwd();
  const leaf = basename(cwd).toLowerCase();
  if (leaf === "seller-api" || leaf === "buyer-client") {
    return resolve(cwd, "..");
  }
  return cwd;
}

const LOG_DIR = process.env.AGENTIC_AUDIT_LOG_DIR ?? join(projectRoot(), "logs");
const SELLER_LOG_PATH = join(LOG_DIR, "seller-events.jsonl");
let writeQueue: Promise<void> = Promise.resolve();

async function appendJsonLine(path: string, data: unknown): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(path, `${JSON.stringify(data)}\n`, { encoding: "utf-8" });
}

export function writeSellerAuditEvent(event: SellerAuditEvent): void {
  const line = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };

  writeQueue = writeQueue
    .then(() => appendJsonLine(SELLER_LOG_PATH, line))
    .catch((error: unknown) => {
      console.warn(
        "[seller-api] audit log write failed:",
        error instanceof Error ? error.message : String(error),
      );
    });
}
