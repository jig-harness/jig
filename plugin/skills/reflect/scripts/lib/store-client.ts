/**
 * The caller's side of the store contract: which command answers for the
 * configured store, and running one operation under its deadline.
 *
 * A store is a command that takes an operation as its first argument, reads
 * JSON or JSONL on stdin and writes JSON or JSONL on stdout. The built-in
 * stores run through the same contract, so the conformance suite that checks
 * them checks any other. When a deadline passes, the store command and
 * everything it started are stopped and the operation counts as unavailable.
 */
import { join } from "node:path";
import { isMapping } from "../../../resolve-review-comments/scripts/lib/config-layers.ts";
import {
  run,
  tsArgv,
} from "../../../resolve-review-comments/scripts/lib/proc.ts";
import { fail } from "../../../resolve-review-comments/scripts/lib/cli.ts";
import {
  type ComputedState,
  computeState,
  distinctById,
  jsonlLines,
  parseEvent,
  parseObject,
  type ReflectionEvent,
  type StoredEvent,
} from "./events.ts";
import type { ReflectionSettings } from "./settings.ts";

export const OPERATIONS = ["check", "append", "list", "diagnose"] as const;
export type Operation = (typeof OPERATIONS)[number];

/** Exit codes of the contract. */
export const EXIT = { done: 0, failed: 1, usage: 2, unavailable: 3 } as const;

/** Operations that read the whole store get five times the deadline. */
export function deadlineFor(op: Operation, timeoutSec: number): number {
  return op === "list" || op === "diagnose" ? timeoutSec * 5 : timeoutSec;
}

/** The command (without the operation) that answers for the store. */
export function storeCommand(settings: ReflectionSettings): string[] {
  switch (settings.store) {
    case "filesystem":
      return tsArgv(join(import.meta.dir, "..", "filesystem-store.ts")).concat([
        "--path",
        settings.path,
      ]);
    case "command":
      return settings.command as string[];
  }
}

export class StoreError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface StoreResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `<command> <op>` with `input` on stdin. A deadline that passes, or a
 * command that cannot be started, reads as unavailable (exit 3).
 */
export async function runStore(
  command: readonly string[],
  op: Operation,
  input: string,
  timeoutSec: number,
): Promise<StoreResult> {
  const r = await run([...command, op], {
    stdin: input,
    timeoutSec: deadlineFor(op, timeoutSec),
  });
  if (r.timedOut)
    return {
      code: EXIT.unavailable,
      stdout: "",
      stderr: `the store's ${op} did not finish within ${deadlineFor(op, timeoutSec)}s`,
    };
  if (r.spawnFailed)
    return {
      code: EXIT.unavailable,
      stdout: "",
      stderr: `the store command could not be started: ${r.stderr.trim()}`,
    };
  return { code: r.code, stdout: r.stdout, stderr: r.stderr };
}

function failed(op: Operation, r: StoreResult): StoreError {
  const code = r.code === EXIT.unavailable ? EXIT.unavailable : EXIT.failed;
  return new StoreError(
    code,
    `the store's ${op} exited ${r.code}: ${r.stderr.trim()}`,
  );
}

/** A store client for the configured store. */
export class Store {
  readonly command: string[];
  readonly timeoutSec: number;

  constructor(command: string[], timeoutSec: number) {
    this.command = command;
    this.timeoutSec = timeoutSec;
  }

  static configured(settings: ReflectionSettings): Store {
    return new Store(storeCommand(settings), settings.timeoutSec);
  }

  async check(): Promise<{
    ok: boolean;
    reason: string | undefined;
    fix: string | undefined;
  }> {
    const r = await runStore(this.command, "check", "", this.timeoutSec);
    if (r.code !== EXIT.done) throw failed("check", r);
    const out = parseObject(r.stdout, "the store's check output");
    return {
      ok: out.ok === true,
      reason: typeof out.reason === "string" ? out.reason : undefined,
      fix: typeof out.fix === "string" ? out.fix : undefined,
    };
  }

  async append(
    events: readonly ReflectionEvent[],
  ): Promise<Array<{ id: string; ref: string | null }>> {
    if (events.length === 0) return [];
    const input = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const r = await runStore(this.command, "append", input, this.timeoutSec);
    if (r.code !== EXIT.done) throw failed("append", r);
    const out = parseObject(r.stdout, "the store's append output");
    const stored: Array<{ id: string; ref: string | null }> = [];
    for (const entry of Array.isArray(out.stored) ? out.stored : [])
      if (isMapping(entry) && typeof entry.id === "string")
        stored.push({
          id: entry.id,
          ref: typeof entry.ref === "string" ? entry.ref : null,
        });
    const missing = events.filter(
      (event) => !stored.some((entry) => entry.id === event.id),
    );
    if (missing.length > 0)
      throw new StoreError(
        EXIT.failed,
        `the store's append did not report ${missing.map((event) => event.id).join(", ")} as stored`,
      );
    return stored;
  }

  /** Every event, each id once, whatever the store returned. */
  async list(since?: string): Promise<StoredEvent[]> {
    const input = since === undefined ? "" : JSON.stringify({ since });
    const r = await runStore(this.command, "list", input, this.timeoutSec);
    if (r.code !== EXIT.done) throw failed("list", r);
    const stored: StoredEvent[] = [];
    for (const [index, text] of jsonlLines(r.stdout).entries()) {
      try {
        stored.push({ event: parseEvent(text), text });
      } catch (error) {
        throw new StoreError(
          EXIT.failed,
          `the store's list returned line ${index + 1}, which is not an event: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return distinctById(stored);
  }

  async diagnose(): Promise<Array<Record<string, unknown>>> {
    const r = await runStore(this.command, "diagnose", "", this.timeoutSec);
    if (r.code !== EXIT.done) throw failed("diagnose", r);
    return jsonlLines(r.stdout).map((line) =>
      parseObject(line, "a diagnose notice"),
    );
  }
}

/** The state computed from every event the store holds. */
export async function storeState(store: Store): Promise<ComputedState> {
  return computeState((await store.list()).map((stored) => stored.event));
}

/** A store error's exit code and message; anything else is a failure. */
export function failureOf(error: unknown): { code: number; message: string } {
  if (error instanceof StoreError)
    return { code: error.code, message: error.message };
  return {
    code: EXIT.failed,
    message: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Run store work; a failure exits with the store's code (3 for an
 * unavailable store), its message followed by `hint` when given.
 */
export async function orExit<T>(
  work: () => Promise<T>,
  hint?: string,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const failure = failureOf(error);
    fail(
      failure.code,
      hint === undefined ? failure.message : `${failure.message}\n${hint}`,
    );
  }
}
