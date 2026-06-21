import { describe, expect, it } from "vitest";
import {
  canonicalizeJsonText,
  hashAuthorizationContent,
  parseJsonText,
  stripUtf8Bom,
} from "../../tools/trustforge/bom-safe-json";

describe("bom-safe-json", () => {
  it("strips UTF-8 BOM before parse", () => {
    const payload = '{"decision":"authorize_one_payment"}';
    const withBom = `\uFEFF${payload}`;
    expect(parseJsonText<{ decision: string }>(withBom).decision).toBe("authorize_one_payment");
  });

  it("normalizes CRLF before parse", () => {
    const payload = '{\r\n  "decision": "authorize_one_payment"\r\n}';
    expect(parseJsonText<{ decision: string }>(payload).decision).toBe("authorize_one_payment");
  });

  it("hashes BOM and CRLF variants identically", () => {
    const lf = '{\n  "decision": "authorize_one_payment"\n}';
    const crlf = '{\r\n  "decision": "authorize_one_payment"\r\n}';
    const bomCrlf = `\uFEFF${crlf}`;
    const hashLf = hashAuthorizationContent(lf);
    expect(hashAuthorizationContent(crlf)).toBe(hashLf);
    expect(hashAuthorizationContent(bomCrlf)).toBe(hashLf);
  });

  it("canonicalizeJsonText is idempotent for LF input", () => {
    const input = '{"a":1}\n';
    expect(canonicalizeJsonText(canonicalizeJsonText(input))).toBe(canonicalizeJsonText(input));
    expect(stripUtf8Bom(input)).toBe(input);
  });
});
