// Runs a command with its standard error passed through as it comes, keeping
// the last part of it in a file once the command ends: scripts/test.ts reads
// bun's closing summary there on the nightly run (classify.ts). Standard
// input and output are the command's own. The exit status is the command's;
// an interrupt or termination is passed on to it, and its end awaited. Once
// the command has exited, what its standard error still holds is read for at
// most DRAIN_GRACE_MS, since a descendant that kept the pipe open would
// otherwise hold the run until the job's time limit.
//
// Usage: bun scripts/nightly/capture-output.ts <tail-file> <command> [args...]
import { writeFileSync } from "node:fs";
import { cli } from "../../lib/cli.ts";
import { NightlyError } from "./baseline.ts";

/** How long the output is read after the command exits. */
export const DRAIN_GRACE_MS = 2_000;

/** How much of the end of the output is kept: the summary is its last lines. */
export const TAIL_BYTES = 64 * 1024;

/** The last `limit` bytes of everything appended. */
export class Tail {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private readonly limit: number;
  constructor(limit = TAIL_BYTES) {
    this.limit = limit;
  }
  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.size += chunk.byteLength;
    while (
      this.chunks.length > 1 &&
      this.size - (this.chunks[0]?.byteLength ?? 0) >= this.limit
    )
      this.size -= this.chunks.shift()?.byteLength ?? 0;
  }
  text(): string {
    const all = Buffer.concat(this.chunks);
    return all
      .subarray(Math.max(0, all.byteLength - this.limit))
      .toString("utf8");
  }
}

export async function captureOutput(args: string[]): Promise<number> {
  const [tailFile, ...command] = args;
  if (!tailFile || !command.length)
    throw new NightlyError(
      "usage: bun scripts/nightly/capture-output.ts <tail-file> <command> [args...]",
    );
  const child = Bun.spawn(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "pipe",
  });
  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {
      // The command has already exited: there is nothing to pass it on to.
    }
  };
  const signals = ["SIGINT", "SIGTERM"] as const;
  const handlers = signals.map((signal) => [signal, forward(signal)] as const);
  for (const [signal, handler] of handlers) process.on(signal, handler);
  const tail = new Tail();
  try {
    const drained = (async () => {
      for await (const chunk of child.stderr) {
        process.stderr.write(chunk);
        tail.push(chunk);
      }
    })();
    const status = await child.exited;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      drained.catch(() => undefined),
      new Promise((done) => {
        timer = setTimeout(done, DRAIN_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
    return status;
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    writeFileSync(tailFile, tail.text());
  }
}

if (import.meta.main) cli(() => captureOutput(process.argv.slice(2)));
