/**
 * buyer-credential-transport-pipe — Windows-first anonymous pipe transport.
 *
 * Uses Node child_process stdio pipes (no shell). Secret bytes are written by
 * the parent process directly to the pipe write end — never via argv/env/files.
 *
 * Windows notes:
 * - Node maps extra stdio 'pipe' entries to anonymous pipes.
 * - Prefer shell:false (default) so no shell host process sees secret bytes.
 * - Parent closes the unused read side; after write, parent ends the write side.
 * - Child reads once from the dedicated fd and closes.
 * - Broad stdio:'inherit' is avoided for the credential channel.
 *
 * JS cannot guarantee deterministic secure erasure of all runtime copies.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PassThrough, type Readable, type Writable } from "node:stream";

import {
  BLOCKED_B34_CREDENTIAL_TRANSPORT_TIMEOUT,
  BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAVAILABLE,
  assertB34CredentialTransportUnavailable,
} from "./b34-execution-gates";
import {
  decodeCredentialTransportFrame,
  encodeCredentialTransportFrame,
  zeroCredentialBytes,
} from "./buyer-credential-transport-frame";
import {
  createAuthorizedOneShotTransport,
  type CredentialTransportLedger,
  type OneShotCredentialTransport,
} from "./buyer-credential-transport";

const DEFAULT_READ_TIMEOUT_MS = 5_000;

export interface InProcessPipeEnds {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly transportId: string;
}

/**
 * Create a same-process anonymous pipe pair for unit tests / synthetic harness.
 * Not a secret discovery path — caller must already hold synthetic bytes.
 */
export function createInProcessCredentialPipe(): InProcessPipeEnds {
  const transportId = `pipe_${randomUUID()}`;
  const channel = new PassThrough();
  return {
    transportId,
    readable: channel,
    writable: channel,
  };
}

async function readExactFrameFromReadable(
  readable: Readable,
  timeoutMs: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  const max = 1 + 2 + 32;

  return new Promise<Uint8Array>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `${BLOCKED_B34_CREDENTIAL_TRANSPORT_TIMEOUT}: credential pipe read timed out`,
        ),
      );
    }, timeoutMs);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readable.off("data", onData);
      readable.off("end", onEnd);
      readable.off("error", onError);
    };

    const onData = (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total > max) {
        cleanup();
        reject(
          new Error(
            `${BLOCKED_B34_CREDENTIAL_TRANSPORT_UNAVAILABLE}: oversized pipe read`,
          ),
        );
      }
    };
    const onEnd = () => {
      cleanup();
      try {
        const merged = Buffer.concat(chunks, total);
        resolve(decodeCredentialTransportFrame(new Uint8Array(merged)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    readable.on("data", onData);
    readable.once("end", onEnd);
    readable.once("error", onError);
    readable.resume();
  });
}

/** Build a one-shot transport that reads exactly one framed credential from a Readable. */
export function createPipeCredentialTransport(input: {
  readonly transportId: string;
  readonly readable: Readable;
  readonly ledger?: CredentialTransportLedger;
  readonly timeoutMs?: number;
}): OneShotCredentialTransport {
  return createAuthorizedOneShotTransport({
    transportId: input.transportId,
    ledger: input.ledger,
    readBytes: async () => {
      const payload = await readExactFrameFromReadable(
        input.readable,
        input.timeoutMs ?? DEFAULT_READ_TIMEOUT_MS,
      );
      try {
        input.readable.destroy();
      } catch {
        // ignore
      }
      return payload;
    },
  });
}

/** Parent writes exactly one frame then ends the write side. */
export async function writeCredentialFrameToPipe(
  writable: Writable,
  payload: Uint8Array,
): Promise<void> {
  const frame = encodeCredentialTransportFrame(payload);
  await new Promise<void>((resolve, reject) => {
    writable.write(frame, (err) => {
      if (err) {
        reject(err);
        return;
      }
      writable.end(() => resolve());
    });
  });
  zeroCredentialBytes(frame);
}

export interface SpawnCredentialTransportChildInput {
  readonly nodeExecutable?: string;
  readonly scriptPath: string;
  readonly scriptArgs?: readonly string[];
  /** Synthetic credential payload only — exactly 32 bytes. */
  readonly syntheticCredentialBytes: Uint8Array;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * Explicit minimal env. Must not contain credential material.
   * Defaults to a filtered copy of process.env without buyer-key names.
   */
  readonly env?: NodeJS.ProcessEnv;
}

export interface SpawnCredentialTransportChildResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly envKeys: readonly string[];
  readonly usedShell: false;
}

function buildMinimalChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const forbidden = new Set([
    "BUYER_PRIVATE_KEY",
    "SEPOLIA_BUYER_PRIVATE_KEY",
    "PRIVATE_KEY",
    "TRUSTFORGE_RUNTIME_KEY",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (forbidden.has(key)) continue;
    if (value === undefined) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Spawn a Node child with an inherited anonymous pipe on fd 3 for the credential.
 * shell is always false. Secret is written only to the pipe after spawn.
 */
export async function spawnCredentialTransportChild(
  input: SpawnCredentialTransportChildInput,
): Promise<SpawnCredentialTransportChildResult> {
  const nodeExecutable = input.nodeExecutable ?? process.execPath;
  const args = [input.scriptPath, ...(input.scriptArgs ?? [])];
  const env = buildMinimalChildEnv(input.env ?? process.env);

  const child = spawn(nodeExecutable, args, {
    cwd: input.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
  });

  const credWritable = child.stdio[3] as Writable | null | undefined;
  if (!credWritable) {
    child.kill();
    assertB34CredentialTransportUnavailable("credential pipe fd was not created");
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (c: Buffer) => stdoutChunks.push(Buffer.from(c)));
  child.stderr?.on("data", (c: Buffer) => stderrChunks.push(Buffer.from(c)));

  try {
    await writeCredentialFrameToPipe(credWritable, input.syntheticCredentialBytes);
  } catch (error) {
    child.kill();
    throw error;
  }

  const timeoutMs = input.timeoutMs ?? 15_000;
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `${BLOCKED_B34_CREDENTIAL_TRANSPORT_TIMEOUT}: child process timed out`,
        ),
      );
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    argv: [nodeExecutable, ...args],
    envKeys: Object.keys(env).sort(),
    usedShell: false,
  };
}

/** Child-side: read framed credential from inherited fd 3. */
export async function readCredentialFrameFromInheritedFd3(
  timeoutMs = DEFAULT_READ_TIMEOUT_MS,
): Promise<Uint8Array> {
  const { createReadStream } = await import("node:fs");
  const readable = createReadStream("", { fd: 3, autoClose: true });
  return readExactFrameFromReadable(readable, timeoutMs);
}
