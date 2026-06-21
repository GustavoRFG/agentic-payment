/**
 * bom-safe-json — UTF-8 BOM stripping and canonical text for parse/hash parity.
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

export function stripUtf8Bom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

export function canonicalizeJsonText(content: string): string {
  return stripUtf8Bom(content).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseJsonText<T>(content: string): T {
  return JSON.parse(canonicalizeJsonText(content)) as T;
}

export async function readJsonFile<T>(path: string): Promise<T> {
  const raw = await readFile(path, "utf8");
  return parseJsonText<T>(raw);
}

export function hashAuthorizationContent(content: string): string {
  return createHash("sha256").update(canonicalizeJsonText(content), "utf8").digest("hex");
}

export async function hashAuthorizationFile(path: string): Promise<string> {
  const raw = await readFile(path, "utf8");
  return hashAuthorizationContent(raw);
}
