/**
 * Authenticated CDP facilitator configuration for Base mainnet.
 *
 * The Coinbase CDP x402 facilitator (https://api.cdp.coinbase.com/platform/v2/x402)
 * rejects unauthenticated requests with HTTP 401. @x402/core's HTTPFacilitatorClient
 * supports an optional `createAuthHeaders` hook that returns per-endpoint headers for
 * the verify, settle, and supported calls. We populate it with CDP Bearer JWTs minted
 * by the official @coinbase/cdp-sdk `getAuthHeaders` helper — no hand-rolled JWT.
 *
 * Testnet (x402.org/facilitator) needs no auth and must keep using a plain
 * `{ url }` config, so this helper is only used when mainnet is active.
 */

import { getAuthHeaders } from "@coinbase/cdp-sdk/auth";
import type { FacilitatorConfig } from "@x402/core/server";

interface FacilitatorEndpoint {
  method: "GET" | "POST";
  suffix: string;
}

// The HTTPFacilitatorClient appends these suffixes to the configured base URL.
const FACILITATOR_ENDPOINTS = {
  verify: { method: "POST", suffix: "/verify" },
  settle: { method: "POST", suffix: "/settle" },
  supported: { method: "GET", suffix: "/supported" },
} as const satisfies Record<string, FacilitatorEndpoint>;

/**
 * Builds an authenticated FacilitatorConfig for the CDP mainnet facilitator.
 *
 * @param facilitatorUrl - Base facilitator URL (e.g. the CDP x402 endpoint).
 * @param apiKeyId - CDP API key id.
 * @param apiKeySecret - CDP API key secret (Ed25519 or EC PEM).
 * @returns A FacilitatorConfig whose createAuthHeaders mints fresh CDP JWTs per call.
 */
export function createCdpFacilitatorConfig(
  facilitatorUrl: string,
  apiKeyId: string,
  apiKeySecret: string,
): FacilitatorConfig {
  const base = new URL(facilitatorUrl);
  const requestHost = base.host;
  const basePath = base.pathname.replace(/\/+$/, "");

  return {
    url: facilitatorUrl,
    createAuthHeaders: async () => {
      const headersFor = (endpoint: FacilitatorEndpoint) =>
        getAuthHeaders({
          apiKeyId,
          apiKeySecret,
          requestMethod: endpoint.method,
          requestHost,
          requestPath: `${basePath}${endpoint.suffix}`,
        });

      const [verify, settle, supported] = await Promise.all([
        headersFor(FACILITATOR_ENDPOINTS.verify),
        headersFor(FACILITATOR_ENDPOINTS.settle),
        headersFor(FACILITATOR_ENDPOINTS.supported),
      ]);

      return { verify, settle, supported };
    },
  };
}
