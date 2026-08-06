/**
 * GUARD_NO_PRODUCTIVE_IMPORT_OF_TEST_ONLY_PAID_CORE
 *
 * The paid core exposes `__testOnly*` seams so tests can drive it without the
 * productive blockers. That is only safe while the seams stay unreachable from
 * productive code: an import of one from tools/, buyer-client/, seller-api/ or
 * shared/ would be a way around the blocker that no blocker could see.
 *
 * Declaring a seam is fine — that is where they live. Importing or calling one
 * from productive code is not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const PRODUCTIVE_ROOTS = ["tools", "buyer-client", "seller-api", "shared"] as const;
const ALLOWED_ROOTS = ["tests"] as const;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".git", "__pycache__"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

/** Importing or calling a seam. Declaring or exporting one is not a violation. */
const IMPORT_PATTERN = /import\s*(?:type\s*)?\{[^}]*__testOnly[A-Za-z0-9_]*/;
const NAMED_IMPORT_LINE = /\b__testOnly[A-Za-z0-9_]*\b/;
const DECLARATION_PATTERN =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+__testOnly/;
const EXPORT_LIST_PATTERN = /^\s*export\s*\{[^}]*\}/;

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXTENSIONS.has(extname(entry)) && !entry.endsWith(".d.ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const root of PRODUCTIVE_ROOTS) {
    for (const file of sourceFiles(root)) {
      const relativePath = relative(process.cwd(), file).split(sep).join("/");
      if (ALLOWED_ROOTS.some((allowed) => relativePath.startsWith(`${allowed}/`))) continue;
      if (/(^|\/)(tests?|__tests__)\//.test(relativePath)) continue;
      if (/\.(test|spec)\.[cm]?tsx?$/.test(relativePath)) continue;

      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!NAMED_IMPORT_LINE.test(line)) return;
        if (DECLARATION_PATTERN.test(line)) return;
        if (EXPORT_LIST_PATTERN.test(line)) return;
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        // an import statement, or any other reference that is not a declaration
        if (IMPORT_PATTERN.test(line) || /\brequire\(/.test(line) || /__testOnly[A-Za-z0-9_]*\s*\(/.test(line)) {
          violations.push({ file: relativePath, line: index + 1, text: line.trim() });
        }
      });
    }
  }
  return violations;
}

describe("GUARD_NO_PRODUCTIVE_IMPORT_OF_TEST_ONLY_PAID_CORE", () => {
  it("no productive module imports or calls a __testOnly paid-core seam", () => {
    const violations = findViolations();
    expect(
      violations,
      `productive code reached a test-only seam:\n${violations
        .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("the guard actually detects a productive import", () => {
    // proves the matcher is not vacuous
    const offending = 'import { __testOnlyRunX402PaidSettlementCore } from "./x402-paid-settlement-runner";';
    expect(IMPORT_PATTERN.test(offending)).toBe(true);
    expect(DECLARATION_PATTERN.test(offending)).toBe(false);
    const call = "  await __testOnlyRunX402PaidSettlementCore({});";
    expect(/__testOnly[A-Za-z0-9_]*\s*\(/.test(call)).toBe(true);
  });

  it("the guard does not flag the declarations themselves", () => {
    for (const declaration of [
      "export async function __testOnlyRunX402PaidSettlementCore(input) {",
      "export const __testOnlyExecuteThinX402SettlementCore = core;",
    ]) {
      expect(DECLARATION_PATTERN.test(declaration)).toBe(true);
    }
  });

  it("scans every productive root", () => {
    for (const root of PRODUCTIVE_ROOTS) {
      expect(sourceFiles(root).length, `${root} had no scanned sources`).toBeGreaterThan(0);
    }
  });
});
