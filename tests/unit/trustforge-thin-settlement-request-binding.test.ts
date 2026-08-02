import { describe, expect, it } from "vitest";

import {
  bindingFromOutboundRequest,
  createThinSettlementRequestBinding,
  requireThinSettlementRequestBinding,
} from "../../tools/trustforge/thin-settlement-request-binding";

const ENDPOINT = "https://api.onesource.io/api/chain/network-info";

function bind(overrides: Partial<Parameters<typeof createThinSettlementRequestBinding>[0]> = {}) {
  return createThinSettlementRequestBinding({
    endpoint: ENDPOINT,
    method: "GET",
    input_status: "known",
    query: { network: "ethereum", mode: "full" },
    body: null,
    ...overrides,
  });
}

describe("thin settlement canonical request binding", () => {
  it("is invariant to object key order", () => {
    const first = bind({ query: { network: "ethereum", mode: "full" } });
    const second = bind({ query: { mode: "full", network: "ethereum" } });
    expect(first.binding_sha256).toBe(second.binding_sha256);
  });

  it("changes for a value, endpoint, or method change", () => {
    const base = bind();
    expect(bind({ query: { network: "base", mode: "full" } }).binding_sha256).not.toBe(
      base.binding_sha256,
    );
    expect(bind({ endpoint: `${ENDPOINT}/other` }).binding_sha256).not.toBe(
      base.binding_sha256,
    );
    const post = bind({ method: "POST", body: {}, query: { network: "ethereum", mode: "full" } });
    expect(post.binding_sha256).not.toBe(base.binding_sha256);
  });

  it("distinguishes explicit empty input from missing input", () => {
    const emptyGet = bind({ query: {}, body: null });
    expect(emptyGet.query).toEqual([]);
    expect(() => requireThinSettlementRequestBinding(undefined)).toThrow(
      "REJECTED_REQUEST_BINDING_NOT_PERSISTED",
    );
    const emptyPost = bind({ method: "POST", query: [], body: {} });
    const nullPost = bind({ method: "POST", query: [], body: null });
    expect(emptyPost.binding_sha256).not.toBe(nullPost.binding_sha256);
  });

  it("preserves repeated query parameters deterministically", () => {
    const binding = bind({ query: { tag: ["one", "two"], network: "ethereum" } });
    expect(binding.query).toEqual([
      ["network", "ethereum"],
      ["tag", "one"],
      ["tag", "two"],
    ]);
    const outbound = bindingFromOutboundRequest({
      endpoint: `${ENDPOINT}?network=ethereum&tag=one&tag=two`,
      method: "GET",
      body: null,
    });
    expect(outbound.binding_sha256).toBe(binding.binding_sha256);
  });

  it.each([
    { query: { nested: { bad: true } }, body: null },
    { query: [], body: { value: undefined } },
    { query: { authorization: "secret" }, body: null },
    { query: [], body: { private_key: "secret" } },
  ])("blocks unsupported or credential-bearing values %#", ({ query, body }) => {
    expect(() => bind({ method: body === null ? "GET" : "POST", query, body })).toThrow(
      "REJECTED_REQUEST_BINDING_INVALID",
    );
  });
});
