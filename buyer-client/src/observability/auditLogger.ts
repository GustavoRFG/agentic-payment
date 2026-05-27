import { appendFile, mkdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { BuyerAuditEvent } from "./auditTypes";

function projectRoot(): string {
  const cwd = process.cwd();
  const leaf = basename(cwd).toLowerCase();
  if (leaf === "seller-api" || leaf === "buyer-client") {
    return resolve(cwd, "..");
  }
  return cwd;
}

const LOG_DIR = process.env.AGENTIC_AUDIT_LOG_DIR ?? join(projectRoot(), "logs");
const BUYER_LOG_PATH = join(LOG_DIR, "buyer-events.jsonl");

async function appendJsonLine(path: string, data: unknown): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  await appendFile(path, `${JSON.stringify(data)}\n`, { encoding: "utf-8" });
}

export async function writeBuyerAuditEvent(
  event: BuyerAuditEvent,
): Promise<void> {
  const line = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };

  try {
    await appendJsonLine(BUYER_LOG_PATH, line);
  } catch (error) {
    console.warn(
      "[buyer-client] audit log write failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
}
