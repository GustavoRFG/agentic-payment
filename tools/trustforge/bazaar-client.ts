/**
 * bazaar-client - thin TrustForge boundary over official x402 Bazaar discovery.
 */

import { MAINNET_FACILITATOR_URL } from "../../shared/payment-safety";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { withBazaar } from "@x402/extensions";
import type { DiscoveryResource } from "@x402/extensions";
import type { PaymentRequirements } from "@x402/core/types";

/** CDP Bazaar discovery (x402.org/facilitator no longer serves /discovery/resources). */
export const DEFAULT_BAZAAR_FACILITATOR_URL = MAINNET_FACILITATOR_URL;
export const TRUSTFORGE_BAZAAR_FACILITATOR_URL_ENV =
  "TRUSTFORGE_BAZAAR_FACILITATOR_URL" as const;

export interface BazaarAccept {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string | null;
  readonly maxTimeoutSeconds: number | null;
  readonly extra: Record<string, unknown>;
}

export interface BazaarResource {
  readonly resourceUrl: string;
  readonly type: string;
  readonly x402Version: number;
  readonly accepts: readonly BazaarAccept[];
  readonly lastUpdated: string | null;
  readonly extensions: Record<string, unknown>;
}

export type BazaarDiscoveryResult =
  | {
      readonly ok: true;
      readonly facilitatorUrl: string;
      readonly resources: readonly BazaarResource[];
      readonly rawCount: number;
    }
  | {
      readonly ok: false;
      readonly facilitatorUrl: string;
      readonly resources: readonly BazaarResource[];
      readonly rawCount: 0;
      readonly error: string;
    };

export interface BazaarClientOptions {
  readonly facilitatorUrl?: string;
}

function configuredFacilitatorUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return (
    env[TRUSTFORGE_BAZAAR_FACILITATOR_URL_ENV]?.trim() ||
    DEFAULT_BAZAAR_FACILITATOR_URL
  );
}

function normalizeAccept(accept: PaymentRequirements): BazaarAccept {
  return {
    scheme: String(accept.scheme ?? ""),
    network: String(accept.network ?? ""),
    asset: String(accept.asset ?? ""),
    amount: String(accept.amount ?? ""),
    payTo: typeof accept.payTo === "string" && accept.payTo ? accept.payTo : null,
    maxTimeoutSeconds:
      typeof accept.maxTimeoutSeconds === "number"
        ? accept.maxTimeoutSeconds
        : null,
    extra:
      accept.extra && typeof accept.extra === "object"
        ? { ...(accept.extra as Record<string, unknown>) }
        : {},
  };
}

export function normalizeBazaarResource(resource: DiscoveryResource): BazaarResource {
  return {
    resourceUrl: String(resource.resource ?? ""),
    type: String(resource.type ?? ""),
    x402Version: Number(resource.x402Version ?? 0),
    accepts: Array.isArray(resource.accepts)
      ? resource.accepts.map((accept) => normalizeAccept(accept))
      : [],
    lastUpdated:
      typeof resource.lastUpdated === "string" && resource.lastUpdated
        ? resource.lastUpdated
        : null,
    extensions:
      resource.extensions && typeof resource.extensions === "object"
        ? { ...(resource.extensions as Record<string, unknown>) }
        : {},
  };
}

export class BazaarClient {
  readonly facilitatorUrl: string;

  constructor(options: BazaarClientOptions = {}) {
    this.facilitatorUrl =
      options.facilitatorUrl?.trim() || configuredFacilitatorUrl();
  }

  async listHttpResources(): Promise<BazaarDiscoveryResult> {
    try {
      const facilitatorClient = new HTTPFacilitatorClient({
        url: this.facilitatorUrl,
      });
      const client = withBazaar(facilitatorClient);
      const response = await client.extensions.bazaar.listResources({
        type: "http",
      });
      if (!Array.isArray(response.items)) {
        return {
          ok: false,
          facilitatorUrl: this.facilitatorUrl,
          resources: [],
          rawCount: 0,
          error: "bazaar response missing items[] (shape mismatch)",
        };
      }
      const raw = response.items;
      return {
        ok: true,
        facilitatorUrl: this.facilitatorUrl,
        resources: raw.map((item) => normalizeBazaarResource(item)),
        rawCount: raw.length,
      };
    } catch (error) {
      return {
        ok: false,
        facilitatorUrl: this.facilitatorUrl,
        resources: [],
        rawCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function resolveBazaarFacilitatorUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  return configuredFacilitatorUrl(env);
}
