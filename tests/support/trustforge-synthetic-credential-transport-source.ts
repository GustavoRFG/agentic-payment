/**
 * Test-only branded synthetic credential transport source.
 * Productive code must never import this module.
 */

import type { SyntheticCredentialTransportSource } from "../../tools/trustforge/buyer-credential-transport-parent";
import { SYNTHETIC_B33_RUNTIME_KEY } from "./trustforge-synthetic-runtime-key";

function hexToBytes(hex: `0x${string}`): Uint8Array {
  const body = hex.slice(2);
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function createSyntheticCredentialTransportSource(
  privateKeyHex: `0x${string}` = SYNTHETIC_B33_RUNTIME_KEY,
): SyntheticCredentialTransportSource {
  return Object.freeze({
    __brand: "SyntheticCredentialTransportSource" as const,
    bytes: hexToBytes(privateKeyHex),
  });
}
