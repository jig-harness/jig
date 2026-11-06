/**
 * A wake: a request that a run (the dispatcher's tick for one repository)
 * start soon, made by a command that writes a record and exits. The record
 * stays where its reader already reads it; the wake only asks the reader to
 * read it sooner, so a wake that is lost delays the request to the reader's
 * next ordinary run and loses nothing.
 *
 * The rule is the one the dispatcher's Orca plugin follows
 * (`design/orca-integration.md`, "Waking the dispatcher"), kept on disk
 * because the command that asks exits at once:
 *
 * - **A pending flag.** Each request is a file in the wake's `pending/`
 *   folder, created under a name no other request takes, so requests never
 *   overwrite each other.
 * - **One waiter.** A detached process waits and runs the target; it holds
 *   the `waiter` file, published by a link that fails while one exists, and
 *   a second waiter exits at once. A requester starts a waiter only when no
 *   live one holds the file.
 * - **One run a minute.** A run starts no sooner than `WAKE_SPACING_MS`
 *   after the last one started (`started`), so several requests within that
 *   minute start one run.
 * - **Counted at the start.** A run takes the requests present when it
 *   starts and removes only those when it ends; a request made while it runs
 *   stays pending, and one trailing run starts once the minute has passed.
 * - **A refused run is retried.** A run that ends `busy` (the tick lock is
 *   machine-wide, so another tick can hold it) keeps its requests and is
 *   tried again after the same minute.
 * - **No resident process.** The waiter exits when nothing is pending, after
 *   `WAKE_ATTEMPTS` runs, or when a run cannot start; a request it leaves is
 *   taken by the next waiter a request starts.
 *
 * A waiter that finds nothing pending gives up the `waiter` file and then
 * looks again: a request made just before it gave up either sees no waiter
 * and starts one, or was written before that last look and is run.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Clock, systemClock } from "./clock.ts";
import { errnoCode } from "./errors.ts";
import type { Outcome } from "./outcome.ts";
import {
  decodeIdentity,
  encodeIdentity,
  isAliveSync,
  lockIdentity,
} from "./liveness.ts";

/** The least time between the starts of two runs of one wake. */
export const WAKE_SPACING_MS = 60_000;

/** The most runs one waiter starts, refused ones included, before it exits. */
export const WAKE_ATTEMPTS = 10;

/** A wake's folder under `root`: one per target, named by its digest. */
export function wakeDir(root: string, target: string): string {
  const digest = createHash("sha256").update(target).digest("hex");
  return join(root, "wake", digest.slice(0, 16));
}

const pendingDir = (dir: string) => join(dir, "pending");
const waiterPath = (dir: string) => join(dir, "waiter");
const startedPath = (dir: string) => join(dir, "started");

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return null;
    throw error;
  }
}

/** The requests pending now, oldest first. */
export function pendingRequests(dir: string): string[] {
  try {
    return readdirSync(pendingDir(dir))
      .filter((name) => !name.endsWith(".tmp"))
      .sort();
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

/** When the last run started, in epoch milliseconds; `null` before the first. */
export function lastStart(dir: string): number | null {
  const text = readOptional(startedPath(dir));
  const ms = text === null ? Number.NaN : Number(text.trim());
  return Number.isSafeInteger(ms) ? ms : null;
}

function writeStarted(dir: string, ms: number): void {
  const temporary = `${startedPath(dir)}.${process.pid}.tmp`;
  writeFileSync(temporary, `${ms}\n`, { mode: 0o600 });
  renameSync(temporary, startedPath(dir));
}

/** The waiter file's holder, unless it is gone: dead, or a file that does not read as one. */
function liveHolder(dir: string): string | null {
  const text = readOptional(waiterPath(dir));
  if (text === null) return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  const holder = decodeIdentity(parsed);
  if (holder === null) return null;
  const verdict = isAliveSync(holder);
  // A holder whose liveness cannot be told keeps the file: a second waiter would start a second run.
  return verdict.ok && verdict.value.state === "dead" ? null : text;
}

/** Take the waiter file for this process; `false` when a live waiter holds it. */
function takeWaiter(dir: string): boolean {
  const path = waiterPath(dir);
  const mine = encodeIdentity(lockIdentity());
  for (let attempt = 0; attempt < 2; attempt++) {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, mine, { mode: 0o600 });
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    } finally {
      rmSync(temporary, { force: true });
    }
    const seen = readOptional(path);
    if (seen === null) continue;
    if (liveHolder(dir) !== null) return false;
    // Remove only the file judged gone, not one another waiter has just published.
    if (readOptional(path) === seen) rmSync(path, { force: true });
  }
  return false;
}

/** Give up the waiter file, when this process holds it. */
function releaseWaiter(dir: string): void {
  if (readOptional(waiterPath(dir)) === encodeIdentity(lockIdentity()))
    rmSync(waiterPath(dir), { force: true });
}

/** What a request found. */
export interface Requested {
  /** Whether the caller must start a waiter: no live one holds the wake. */
  startWaiter: boolean;
  /** When the run starts: at once, or within the minute after the last one started. */
  when: "now" | "soon";
}

/** Record a request in the wake at `dir`, and say whether a waiter must be started for it. */
export function requestWake(
  dir: string,
  clock: Pick<Clock, "now"> = systemClock,
): Requested {
  const pending = pendingDir(dir);
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  const now = clock.now();
  const name = `${String(now).padStart(15, "0")}-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(join(pending, name), "", { flag: "wx", mode: 0o600 });
  const waiting = liveHolder(dir) !== null;
  const last = lastStart(dir);
  const spaced = last === null || now - last >= WAKE_SPACING_MS;
  return { startWaiter: !waiting, when: !waiting && spaced ? "now" : "soon" };
}

/** What a waiter needs: the clock, the run, and the exit code that means the run was refused. */
export interface WaitDeps {
  clock?: Clock;
  /** Start the run and wait for its exit code; a failure when it could not start. */
  run(): Promise<Outcome<number, "unstarted">>;
  /** The exit code of a run that was refused and must be retried. */
  busy: number;
  /** Told why the waiter ended, or what a run returned. */
  note?(line: string): void;
}

/** How a waiter ended: nothing pending; another waiter holds the wake; its bound reached; a run that could not start. */
export type WaitEnd = "idle" | "elsewhere" | "bounded" | "failed";

/**
 * Wait for the wake at `dir` and run its target under the rule above, until
 * nothing is pending, the bound is reached or a run cannot start.
 */
export async function waitAndRun(
  dir: string,
  deps: WaitDeps,
): Promise<{ end: WaitEnd; runs: number }> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!takeWaiter(dir)) return { end: "elsewhere", runs: 0 };
  const count = { attempts: 0, runs: 0 };
  try {
    let end: WaitEnd | null = null;
    while (end === null) end = await turn(dir, deps, count);
    return { end, runs: count.runs };
  } finally {
    releaseWaiter(dir);
  }
}

/** One turn of the waiter: wait for the minute, or run once; `null` to go on, else how it ends. */
async function turn(
  dir: string,
  deps: WaitDeps,
  count: { attempts: number; runs: number },
): Promise<WaitEnd | null> {
  const clock = deps.clock ?? systemClock;
  const taken = pendingRequests(dir);
  if (taken.length === 0) return idle(dir);
  if (count.attempts >= WAKE_ATTEMPTS) {
    deps.note?.(
      `${count.attempts} runs started; ${taken.length} requests are left for the next wake`,
    );
    return "bounded";
  }
  const now = clock.now();
  const due = (lastStart(dir) ?? Number.NEGATIVE_INFINITY) + WAKE_SPACING_MS;
  if (now < due) {
    await clock.sleep(due - now);
    return null;
  }
  count.attempts++;
  writeStarted(dir, now);
  const ran = await deps.run();
  if (!ran.ok) {
    deps.note?.(`the run did not start: ${ran.failure.reason}`);
    return "failed";
  }
  if (ran.value === deps.busy) {
    deps.note?.(
      `the run was refused (exit ${ran.value}); it is tried again in a minute`,
    );
    return null;
  }
  count.runs++;
  deps.note?.(`the run exited ${ran.value}, taking ${taken.length} requests`);
  for (const name of taken)
    rmSync(join(pendingDir(dir), name), { force: true });
  return null;
}

/**
 * Nothing pending: give the wake up, then look once more, so a request
 * made just before is run; `null` when one was and the wake is taken back.
 */
function idle(dir: string): WaitEnd | null {
  releaseWaiter(dir);
  if (pendingRequests(dir).length === 0) return "idle";
  return takeWaiter(dir) ? null : "elsewhere";
}
