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
    "tools/trustforge/explicit-runtime-key-credential-provider.ts",
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

  it("GUARD_NO_PRODUCTIVE_IMPLICIT_CREDENTIAL_PROVIDER_FALLBACK", () => {
    const registry = readFileSync(
      "tools/trustforge/buyer-credential-provider-registry.ts",
      "utf8",
    );
    expect(registry).toMatch(/BLOCKED_B32_CREDENTIAL_PROVIDER_UNKNOWN/);
    expect(registry).toMatch(/BLOCKED_B32_CREDENTIAL_PROVIDER_AMBIGUOUS/);
    expect(registry).toMatch(/assertExplicitProviderSelection/);
    expect(registry).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(registry).not.toMatch(/BUYER_PRIVATE_KEY/);
    expect(registry).not.toMatch(/fallback.*=.*true/);

    const gated = readFileSync("tools/trustforge/buyer-credential-gated-signing.ts", "utf8");
    expect(gated).toMatch(/assertExplicitProviderSelection/);
    expect(gated).toMatch(/resolveProductiveCredentialProvider/);
    expect(gated).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
  });

  it("GUARD_NO_PRODUCTIVE_GENERAL_PURPOSE_BUYER_SIGNER", () => {
    const adapters = readFileSync(
      "tools/trustforge/buyer-credential-provider-adapters.ts",
      "utf8",
    );
    expect(adapters).toMatch(/RestrictedBuyerAuthorizationSigner/);
    expect(adapters).toMatch(/BLOCKED_B32_REAL_CREDENTIAL_BACKEND_INACTIVE/);
    expect(adapters).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(adapters).not.toMatch(/privateKeyToAccount/);
    expect(adapters).not.toMatch(/createWalletClient/);
    expect(adapters).not.toMatch(/signMessage\s*\(/);
    expect(adapters).not.toMatch(/signTransaction\s*\(/);

    const signer = readFileSync("tools/trustforge/buyer-authorization-signer.ts", "utf8");
    expect(signer).toMatch(/ValidatedBuyerTypedData/);
    // Productive BuyerAuthorizationSigner must not advertise general-purpose APIs.
    expect(signer).not.toMatch(/signMessage\s*\(/);
    expect(signer).not.toMatch(/signTransaction\s*\(/);

    const runtimeKey = readFileSync(
      "tools/trustforge/explicit-runtime-key-credential-provider.ts",
      "utf8",
    );
    expect(runtimeKey).not.toMatch(/signMessage\s*\(/);
    expect(runtimeKey).not.toMatch(/signTransaction\s*\(/);
    expect(runtimeKey).not.toMatch(/sendTransaction/);
    expect(runtimeKey).not.toMatch(/writeContract/);
    expect(runtimeKey).not.toMatch(/createWalletClient/);
  });

  it("GUARD_EXPLICIT_RUNTIME_KEY_ACCESS_ONLY_IN_AUTHORIZED_PROVIDER", () => {
    const allowed = new Set([
      "tools/trustforge/explicit-runtime-key-credential-provider.ts",
    ]);
    const buyerBoundary =
      /(^|\/)(buyer-|b31-|b32-|b33-|explicit-runtime-key)/;
    const hits: string[] = [];
    for (const root of PRODUCTIVE_ROOTS) {
      for (const file of sourceFiles(root)) {
        const relativePath = relative(process.cwd(), file).split(sep).join("/");
        if (/(^|\/)(tests?|__tests__|support)\//.test(relativePath)) continue;
        if (/\.(test|spec)\.[cm]?tsx?$/.test(relativePath)) continue;
        if (!buyerBoundary.test(relativePath.split("/").pop() ?? "")) continue;
        if (allowed.has(relativePath)) continue;
        const text = readFileSync(file, "utf8");
        if (/privateKeyToAccount/.test(text)) {
          hits.push(relativePath);
        }
      }
    }
    expect(hits).toEqual([]);

    const adapter = readFileSync(
      "tools/trustforge/explicit-runtime-key-credential-provider.ts",
      "utf8",
    );
    expect(adapter).toMatch(/privateKeyToAccount/);
    expect(adapter).toMatch(/AuthorizedExplicitRuntimeCredentialAccess/);
    expect(adapter).not.toMatch(/process\.env\./);
    expect(adapter).not.toMatch(/BUYER_PRIVATE_KEY/);
    expect(adapter).not.toMatch(/dotenv/);
    expect(adapter).not.toMatch(/readFileSync/);
  });

  it("GUARD_NO_BUYER_RUNTIME_KEY_SECRET_LEAKAGE", () => {
    const adapter = readFileSync(
      "tools/trustforge/explicit-runtime-key-credential-provider.ts",
      "utf8",
    );
    // Errors must use stable helper/codes; never interpolate privateKey into messages.
    expect(adapter).toMatch(/assertB33RuntimeKeyCredentialInvalid/);
    expect(adapter).toMatch(/assertB33RuntimeKeyCredentialMissing/);
    expect(adapter).not.toMatch(/\$\{[^}]*privateKey/);
    expect(adapter).not.toMatch(/JSON\.stringify\([^\)]*privateKey/);
    expect(adapter).not.toMatch(/console\.(log|error|warn|debug)/);
  });

  it("GUARD_NO_SECRET_TRANSPORT_THROUGH_SHELL", () => {
    const pipe = readFileSync(
      "tools/trustforge/buyer-credential-transport-pipe.ts",
      "utf8",
    );
    const parent = readFileSync(
      "tools/trustforge/buyer-credential-transport-parent.ts",
      "utf8",
    );
    expect(pipe).toMatch(/shell:\s*false/);
    expect(pipe).not.toMatch(/shell:\s*true/);
    expect(pipe).not.toMatch(/shell:\s*['"]true['"]/);
    expect(parent).not.toMatch(/shell:\s*true/);
    // No shell-host spawn helpers in transport modules.
    expect(pipe).not.toMatch(/execSync\(/);
    expect(parent).not.toMatch(/execSync\(/);
  });

  it("GUARD_NO_RUNTIME_KEY_TRANSPORT_FALLBACK", () => {
    const transport = readFileSync(
      "tools/trustforge/buyer-credential-transport.ts",
      "utf8",
    );
    const gated = readFileSync("tools/trustforge/buyer-credential-gated-signing.ts", "utf8");
    expect(transport).toMatch(/assertB34NoTransportFallback|rejectRuntimeKeyTransportFallback/);
    expect(transport).toMatch(/BLOCKED_B34_CREDENTIAL_TRANSPORT_FALLBACK_FORBIDDEN|assertB34NoTransportFallback/);
    expect(gated).toMatch(/credentialTransport/);
    expect(gated).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);
    expect(gated).not.toMatch(/process\.argv/);
  });

  it("GUARD_RUNTIME_KEY_TRANSPORT_ONE_SHOT", () => {
    const transport = readFileSync(
      "tools/trustforge/buyer-credential-transport.ts",
      "utf8",
    );
    expect(transport).toMatch(/TRANSPORT_UNREAD/);
    expect(transport).toMatch(/TRANSPORT_READ_INVOKED/);
    expect(transport).toMatch(/TRANSPORT_CONSUMED/);
    expect(transport).toMatch(/BLOCKED_B34_CREDENTIAL_TRANSPORT_CONSUMED/);
    expect(transport).toMatch(/markReadInvoked/);
  });

  it("GUARD_NO_RUNTIME_KEY_IN_ARGV_OR_ENV", () => {
    const pipe = readFileSync(
      "tools/trustforge/buyer-credential-transport-pipe.ts",
      "utf8",
    );
    const parent = readFileSync(
      "tools/trustforge/buyer-credential-transport-parent.ts",
      "utf8",
    );
    expect(pipe).toMatch(/buildMinimalChildEnv|forbidden/);
    expect(pipe).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY\s*=/);
    expect(pipe).not.toMatch(/--private-key/);
    expect(parent).not.toMatch(/--private-key/);
    expect(parent).not.toMatch(/process\.env\.BUYER_PRIVATE_KEY/);

    const supportImport =
      /trustforge-synthetic-credential-transport-source|b34-credential-transport-child\.mjs/;
    const hits: string[] = [];
    for (const root of PRODUCTIVE_ROOTS) {
      for (const file of sourceFiles(root)) {
        const relativePath = relative(process.cwd(), file).split(sep).join("/");
        if (/(^|\/)(tests?|__tests__|support)\//.test(relativePath)) continue;
        if (/\.(test|spec)\.[cm]?tsx?$/.test(relativePath)) continue;
        if (supportImport.test(readFileSync(file, "utf8"))) hits.push(relativePath);
      }
    }
    expect(hits).toEqual([]);
  });
});
