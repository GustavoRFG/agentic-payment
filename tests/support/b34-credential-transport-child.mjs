/**
 * Plain Node child for B.3.4 spawn tests (no TS loader).
 * Reads one framed credential from inherited fd 3; never prints the secret.
 */

import { createReadStream } from "node:fs";

const VERSION = 0x01;
const PAYLOAD_LEN = 32;

function decodeFrame(buffer) {
  if (buffer.byteLength === 0) throw new Error("empty");
  if (buffer.byteLength > 1 + 2 + PAYLOAD_LEN) throw new Error("oversized");
  if (buffer.byteLength < 3) throw new Error("truncated");
  if (buffer[0] !== VERSION) throw new Error("version");
  const length = (buffer[1] << 8) | buffer[2];
  if (length !== PAYLOAD_LEN) throw new Error("length");
  if (buffer.byteLength !== 3 + length) throw new Error("trailing_or_trunc");
  return buffer.subarray(3, 3 + length);
}

async function readFd3() {
  const readable = createReadStream("", { fd: 3, autoClose: true });
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.from(chunk));
  }
  const merged = Buffer.concat(chunks);
  const payload = decodeFrame(merged);
  payload.fill(0);
}

try {
  await readFd3();
  process.stdout.write("transport_ok\n");
  process.exitCode = 0;
} catch {
  process.stderr.write("transport_fail\n");
  process.exitCode = 2;
}
