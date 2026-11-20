/** Transfer a launch's environment in memory, through a one-use local socket. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { isMapping } from "../../../shared/config-layers.ts";
import { swallow } from "../../../shared/errors.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { readLaunch } from "../read-launch.ts";

export interface ProcessRequest {
  id: string;
  token: string;
  workspace: string;
  env: Record<string, string>;
}

interface ProcessOffer {
  address: string;
  accepted: Promise<boolean>;
  close(): void;
}

/** OS environment blocks fit within this bound, including their encoding. */
const MAX_MESSAGE = 1024 * 1024;
const ACK_BYTES = 32;
const ACK_LENGTH = ACK_BYTES * 2;
const RECEIVE_TIMEOUT_MS = 60_000;

function key(token: string): Buffer {
  return createHash("sha256")
    .update("jig process launch v1\0")
    .update(token)
    .digest();
}

function seal(request: ProcessRequest, ack: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(request.token), iv);
  const plain = JSON.stringify({ env: request.env, ack: ack.toString("hex") });
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
}

function unseal(message: string, token: string) {
  const bytes = Buffer.from(message, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key(token),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  const opened = Buffer.concat([
    decipher.update(bytes.subarray(28)),
    decipher.final(),
  ]);
  const value: unknown = JSON.parse(opened.toString("utf8"));
  if (
    !isMapping(value) ||
    typeof value.ack !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.ack) ||
    !isMapping(value.env)
  )
    return null;
  const env: Record<string, string> = Object.create(null);
  for (const [name, entry] of Object.entries(value.env)) {
    if (typeof entry !== "string") return null;
    env[name] = entry;
  }
  return { ack: value.ack, env };
}

/** The server chooses its transport address before the service manager starts. */
function addressOf(): { address: string; directory?: string } {
  if (process.platform === "win32")
    return {
      address: `\\\\.\\pipe\\jig-run-${randomBytes(16).toString("hex")}`,
    };
  // Keep the pathname within sockaddr_un even with a long home or TMPDIR.
  const directory = mkdtempSync("/tmp/jig-run-");
  return { address: join(directory, "request.sock"), directory };
}

/** Receive one bounded LF-terminated frame without logging the data. */
function readLine(socket: Socket, limit: number): Promise<string | null> {
  return new Promise((finish) => {
    let data = "";
    const settle = (line: string | null) => {
      socket.off("data", receive);
      socket.off("close", closed);
      finish(line);
    };
    const closed = () => settle(null);
    const receive = (chunk: Buffer) => {
      data += chunk.toString("ascii");
      if (data.length > limit + 1) {
        settle(null);
      } else if (data.endsWith("\n")) {
        settle(data.slice(0, -1));
      }
    };
    socket.on("data", receive);
    socket.once("close", closed);
  });
}

/** Only a bootstrap that can read the launch's existing token can accept. */
export async function offerProcessRequest(
  request: ProcessRequest,
  timeoutMs: number,
): Promise<Outcome<ProcessOffer>> {
  try {
    const ack = randomBytes(ACK_BYTES);
    const payload = seal(request, ack);
    if (payload.length > MAX_MESSAGE)
      return failed(
        "process-request-too-large",
        "the process environment exceeds the launch transfer limit",
      );
    const { address, directory } = addressOf();
    const sockets = new Set<Socket>();
    const accepted = Promise.withResolvers<boolean>();
    const listening = Promise.withResolvers<boolean>();
    let winner = false;
    const server = createServer((socket) => {
      socket.on("error", () => socket.destroy());
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.setTimeout(timeoutMs, () => socket.destroy());
      if (winner) {
        socket.destroy();
        return;
      }
      const reply = readLine(socket, ACK_LENGTH);
      socket.write(`${payload}\n`);
      void reply.then((line) => {
        if (
          winner ||
          line?.length !== ACK_LENGTH ||
          !/^[0-9a-f]+$/.test(line) ||
          !timingSafeEqual(ack, Buffer.from(line, "hex"))
        ) {
          socket.destroy();
          return;
        }
        winner = true;
        socket.end("ok\n", () => accepted.resolve(true));
      });
    });
    server.maxConnections = 16;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      accepted.resolve(false);
      listening.resolve(false);
      server.close();
      for (const socket of sockets) socket.destroy();
      if (directory !== undefined) {
        try {
          rmSync(directory, { force: true, recursive: true });
        } catch (error) {
          swallow(
            error,
            "could not remove the process launch socket directory",
          );
        }
      }
    };
    const timer = setTimeout(close, timeoutMs);
    server.on("error", close);
    server.listen(address, () => listening.resolve(true));
    if (!(await listening.promise))
      return failed(
        "process-ipc-unavailable",
        "could not listen for the process runtime bootstrap",
      );
    return ok({ address, accepted: accepted.promise, close });
  } catch (error) {
    return failed(
      "process-ipc-unavailable",
      "could not offer the process launch environment",
      error,
    );
  }
}

export async function readProcessRequest(
  address: string,
  id: string,
  root: string,
): Promise<Outcome<ProcessRequest>> {
  const found = readLaunch(id, root);
  if (!found.ok) return found;
  const record = found.value;
  if (record?.runtime !== "process" || record.workspace === null)
    return failed(
      "process-record-missing",
      "the process launch record has no workspace",
    );
  const socket = createConnection(address);
  socket.on("error", () => socket.destroy());
  socket.setTimeout(RECEIVE_TIMEOUT_MS, () => socket.destroy());
  try {
    const message = await readLine(socket, MAX_MESSAGE);
    const payload = message === null ? null : unseal(message, record.token);
    if (payload !== null) {
      const confirmed = readLine(socket, 2);
      socket.write(`${payload.ack}\n`);
      if ((await confirmed) === "ok")
        return ok({
          id,
          token: record.token,
          workspace: record.workspace.path,
          env: payload.env,
        });
    }
    return failed(
      "process-request-refused",
      "the process launch environment was not accepted",
    );
  } catch {
    return failed(
      "process-request-refused",
      "the process launch environment could not be authenticated",
    );
  } finally {
    socket.destroy();
  }
}
