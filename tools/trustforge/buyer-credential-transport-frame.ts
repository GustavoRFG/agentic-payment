/**
 * buyer-credential-transport-frame — bounded binary framing for one credential.
 *
 * Layout (v1):
 *   [0]     version = 0x01
 *   [1..2]  payload_length uint16 big-endian
 *   [3..]   exact credential bytes
 *
 * Exactly one frame. No trimming. No Unicode decode. Reject trailing bytes.
 */

import {
  BLOCKED_B34_CREDENTIAL_TRANSPORT_FRAME_INVALID,
} from "./b34-execution-gates";

export const B34_TRANSPORT_FRAME_VERSION = 0x01 as const;
/** Runtime private keys are exactly 32 bytes. */
export const B34_TRANSPORT_PAYLOAD_EXACT_LENGTH = 32 as const;
export const B34_TRANSPORT_MAX_FRAME_LENGTH =
  1 + 2 + B34_TRANSPORT_PAYLOAD_EXACT_LENGTH;

function fail(detail: string): never {
  throw new Error(`${BLOCKED_B34_CREDENTIAL_TRANSPORT_FRAME_INVALID}: ${detail}`);
}

/** Encode exactly one credential frame. */
export function encodeCredentialTransportFrame(payload: Uint8Array): Uint8Array {
  if (!(payload instanceof Uint8Array)) {
    fail("payload must be Uint8Array");
  }
  if (payload.byteLength !== B34_TRANSPORT_PAYLOAD_EXACT_LENGTH) {
    fail("payload length must be exactly 32 bytes");
  }
  if (payload.byteLength === 0) {
    fail("zero-length payload forbidden");
  }
  const frame = new Uint8Array(B34_TRANSPORT_MAX_FRAME_LENGTH);
  frame[0] = B34_TRANSPORT_FRAME_VERSION;
  frame[1] = (payload.byteLength >> 8) & 0xff;
  frame[2] = payload.byteLength & 0xff;
  frame.set(payload, 3);
  return frame;
}

/**
 * Decode exactly one frame from a closed buffer (full pipe read).
 * Rejects truncation, trailing bytes, wrong version, wrong length.
 */
export function decodeCredentialTransportFrame(buffer: Uint8Array): Uint8Array {
  if (!(buffer instanceof Uint8Array)) {
    fail("frame buffer must be Uint8Array");
  }
  if (buffer.byteLength === 0) {
    fail("empty frame");
  }
  if (buffer.byteLength > B34_TRANSPORT_MAX_FRAME_LENGTH) {
    fail("oversized frame");
  }
  if (buffer.byteLength < 3) {
    fail("truncated frame header");
  }
  if (buffer[0] !== B34_TRANSPORT_FRAME_VERSION) {
    fail("unsupported frame version");
  }
  const length = ((buffer[1]! << 8) | buffer[2]!) >>> 0;
  if (length === 0) {
    fail("zero-length payload forbidden");
  }
  if (length !== B34_TRANSPORT_PAYLOAD_EXACT_LENGTH) {
    fail("payload length must be exactly 32 bytes");
  }
  const expectedTotal = 3 + length;
  if (buffer.byteLength < expectedTotal) {
    fail("truncated frame payload");
  }
  if (buffer.byteLength > expectedTotal) {
    fail("trailing bytes after credential frame");
  }
  const payload = new Uint8Array(length);
  payload.set(buffer.subarray(3, expectedTotal));
  return payload;
}

/** Best-effort zero of a mutable buffer. */
export function zeroCredentialBytes(bytes: Uint8Array | null | undefined): void {
  if (bytes) {
    bytes.fill(0);
  }
}
