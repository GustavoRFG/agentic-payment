/**
 * GUARD_NO_PRODUCTIVE_IMPORT_OF_TEST_ONLY_PAID_CORE
 * GUARD_NO_PRODUCTIVE_TEST_SUPPORT_DEPENDENCY
 * GUARD_NO_PRODUCTIVE_UNVALIDATED_BUYER_SIGNING_ENTRYPOINT
 *
 * Structural barrier after B.2 audit:
 * - productive modules must not export or call `__testOnly*` seams;
 * - productive modules must not import `tests/**` or `test-support`;
 * - productive modules must not call signTypedData except inside the
 *   mandatory pre-sign-validated signing entry point.
 *
 * Historical tests reach paid cores only via `tests/support/`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const PRODUCTIVE_ROOTS = ["tools", "buyer-client", "seller-api", "shared"] as const;
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", ".git", "__pycache__"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"]);

const TEST_ONLY_SYMBOL = /\b__testOnly[A-Za-z0-9_]*\b/;
const TEST_ONLY_DECLARATION =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+__testOnly/;
const TEST_SUPPORT_IMPORT =
  /(?:from\s+["'][^"']*(?:\/tests\/|tests\/support|test-support)[^"']*["']|import\s*\(\s*["'][^"']*(?:\/tests\/|tests\/support|test-support)[^"']*["']\s*\))/;
const DYNAMIC_TEST_ONLY_IMPORT =
  /import\s*\(\s*["'][^"']*["']\s*\)[^;]*__testOnly|__testOnly[A-Za-z0-9_]*\s*\(/;

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
  readonly kind: string;
}

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const root of PRODUCTIVE_ROOTS) {
    for (const file of sourceFiles(root)) {
      const relativePath = relative(process.cwd(), file).split(sep).join("/");
      if (/(^|\/)(tests?|__tests__|support)\//.test(relativePath)) continue;
      if (/\.(test|spec)\.[cm]?tsx?$/.test(relativePath)) continue;

      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;

        if (TEST_SUPPORT_IMPORT.test(line)) {
          violations.push({
            file: relativePath,
            line: index + 1,
            text: line.trim(),
            kind: "test-support-dependency",
          });
          return;
        }

        if (!TEST_ONLY_SYMBOL.test(line)) return;
        if (TEST_ONLY_DECLARATION.test(line)) {
          violations.push({
            file: relativePath,
            line: index + 1,
            text: line.trim(),
            kind: "test-only-export-or-declaration",
          });
          return;
        }
        if (
          /import\s*(?:type\s*)?\{[^}]*__testOnly/.test(line) ||
          /\brequire\(/.test(line) ||
          DYNAMIC_TEST_ONLY_IMPORT.test(line)
        ) {
          violations.push({
            file: relativePath,
            line: index + 1,
            text: line.trim(),
            kind: "test-only-import-or-call",
          });
        }
      });
    }
  }
  return violations;
}

describe("GUARD_NO_PRODUCTIVE_IMPORT_OF_TEST_ONLY_PAID_CORE", () => {
  it("no productive module declares, imports, or calls a __testOnly paid-core seam", () => {
    const violations = findViolations().filter((v) => v.kind.startsWith("test-only"));
    expect(
      violations,
      `productive code reached a test-only seam:\n${violations
        .map((v) => `  ${v.kind} ${v.file}:${v.line}  ${v.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("the guard detects a productive __testOnly import", () => {
    const offending = 'import { __testOnlyRunX402PaidSettlementCore } from "./x402-paid-settlement-runner";';
    expect(/import\s*(?:type\s*)?\{[^}]*__testOnly/.test(offending)).toBe(true);
  });
});

describe("GUARD_NO_PRODUCTIVE_TEST_SUPPORT_DEPENDENCY", () => {
  it("no productive module depends on tests/ or test-support", () => {
    const violations = findViolations().filter((v) => v.kind === "test-support-dependency");
    expect(
      violations,
      `productive code depends on test support:\n${violations
        .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("the guard detects a productive tests/support import", () => {
    const offending =
      'import { runX402PaidSettlement } from "../../tests/support/trustforge-paid-core-seams";';
    expect(TEST_SUPPORT_IMPORT.test(offending)).toBe(true);
    const dynamic =
      'const m = await import("../tests/support/trustforge-paid-core-seams");';
    expect(TEST_SUPPORT_IMPORT.test(dynamic)).toBe(true);
  });

  it("scans every productive root", () => {
    for (const root of PRODUCTIVE_ROOTS) {
      expect(sourceFiles(root).length, `${root} had no scanned sources`).toBeGreaterThan(0);
    }
  });
});

describe("GUARD_NO_PRODUCTIVE_UNVALIDATED_BUYER_SIGNING_ENTRYPOINT", () => {
  const ALLOWED_SIGN_TYPED_DATA = new Set([
    "tools/trustforge/buyer-eip3009-authorization.ts",
    "tools/trustforge/buyer-authorization-signer.ts",
  ]);
  const BYPASS_EXPORT =
    /^\s*export\s+(?:async\s+)?(?:function|const)\s+(?:signUnsignedPayload|signTypedDataWithoutValidation|__unsafeSign|rawSignUnsigned)/;

  it("only the validated signing entry point may call signTypedData in productive code", () => {
    const violations: Violation[] = [];
    for (const root of PRODUCTIVE_ROOTS) {
      for (const file of sourceFiles(root)) {
        const relativePath = relative(process.cwd(), file).split(sep).join("/");
        if (/(^|\/)(tests?|__tests__|support)\//.test(relativePath)) continue;
        if (/\.(test|spec)\.[cm]?tsx?$/.test(relativePath)) continue;
        const lines = readFileSync(file, "utf8").split(/\r?\n/);
        lines.forEach((line, index) => {
          if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
          if (BYPASS_EXPORT.test(line)) {
            violations.push({
              file: relativePath,
              line: index + 1,
              text: line.trim(),
              kind: "unvalidated-signing-export",
            });
          }
          if (/\.signTypedData\s*\(/.test(line) && !ALLOWED_SIGN_TYPED_DATA.has(relativePath)) {
            violations.push({
              file: relativePath,
              line: index + 1,
              text: line.trim(),
              kind: "signTypedData-outside-validated-entrypoint",
            });
          }
        });
      }
    }
    expect(
      violations,
      `unvalidated signing entrypoint:\n${violations
        .map((v) => `  ${v.kind} ${v.file}:${v.line}  ${v.text}`)
        .join("\n")}`,
    ).toEqual([]);
  });

  it("signUnsignedAuthorization accepts only ValidatedBuyerAuthorizationForSigning", () => {
    const source = readFileSync("tools/trustforge/buyer-eip3009-authorization.ts", "utf8");
    const fnStart = source.indexOf("export async function signUnsignedAuthorization");
    expect(fnStart).toBeGreaterThanOrEqual(0);
    const body = source.slice(fnStart, fnStart + 1200);
    expect(body).toMatch(/ValidatedBuyerAuthorizationForSigning/);
    expect(body).toMatch(/validated\.typedData/);
    // No productive overload that accepts only raw unsigned + signer.
    expect(source).not.toMatch(
      /signUnsignedAuthorization\(input:\s*\{\s*readonly unsigned:\s*UnsignedBuyerAuthorization/,
    );
    expect(source).not.toMatch(
      /readonly unsignedArtifact:\s*UnsignedArtifact[\s\S]{0,200}readonly signer:/,
    );
  });

  it("GUARD_NO_PRODUCTIVE_RAW_BUYER_SIGNING_BYPASS: B.3 path requires validated factory", () => {
    const signerSource = readFileSync("tools/trustforge/buyer-authorization-signer.ts", "utf8");
    expect(signerSource).toMatch(/prepareValidatedBuyerAuthorizationForSigning/);
    expect(signerSource).toMatch(/ValidatedBuyerTypedData/);
    expect(signerSource).toMatch(/assertB3PaymentBearingSendNotAuthorized|BLOCKED_B3_PAYMENT_BEARING_SEND_NOT_AUTHORIZED/);
    expect(signerSource).toMatch(/BLOCKED_B3_REAL_SIGNER_CREDENTIAL_PROVIDER_NOT_AUTHORIZED/);
    // Credential provider has no env/key loader.
    expect(signerSource).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(signerSource).not.toMatch(/privateKeyToAccount/);
  });

  it("GUARD_NO_PRODUCTIVE_UNAUTHORIZED_BUYER_CREDENTIAL_ACCESS", () => {
    const gated = readFileSync("tools/trustforge/buyer-credential-gated-signing.ts", "utf8");
    expect(gated).toMatch(/BLOCKED_B31_CREDENTIAL_ACCESS_NOT_AUTHORIZED/);
    expect(gated).toMatch(/prepareValidatedBuyerAuthorizationForSigning/);
    expect(gated).toMatch(/validateBuyerCredentialAccessAuthorization/);
    expect(gated).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(gated).not.toMatch(/privateKeyToAccount/);
    expect(gated).not.toMatch(/dotenv/);
    expect(gated).not.toMatch(/createWalletClient/);
    expect(gated).not.toMatch(/mnemonic/);

    const provider = readFileSync("tools/trustforge/buyer-credential-provider.ts", "utf8");
    expect(provider).toMatch(/assertB31CredentialAccessNotAuthorized/);
    expect(provider).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(provider).not.toMatch(/privateKeyToAccount/);
    expect(provider).not.toMatch(/readFileSync/);

    // Synthetic provider must stay under tests/support.
    const supportImport =
      /(?:from\s+["'][^"']*trustforge-synthetic-credential-provider[^"']*["']|import\s*\(\s*["'][^"']*trustforge-synthetic-credential-provider[^"']*["']\s*\))/;
    const productiveHits: string[] = [];
    for (const root of PRODUCTIVE_ROOTS) {
      for (const file of sourceFiles(root)) {
        const relativePath = relative(process.cwd(), file).split(sep).join("/");
        if (/(^|\/)(tests?|__tests__|support)\//.test(relativePath)) continue;
        if (/\.(test|spec)\.[cm]?tsx?$/.test(relativePath)) continue;
        const text = readFileSync(file, "utf8");
        if (supportImport.test(text)) productiveHits.push(relativePath);
      }
    }
    expect(productiveHits).toEqual([]);
  });
});
