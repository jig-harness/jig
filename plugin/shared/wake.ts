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
 *   overwrite each other. The file holds who asked and why (`send`, or the
 *   change probe's `probe: …` line), and the waiter's note for the run that
 *   takes it names them.
 * - **One waiter.** A detached process waits and runs the target; it holds
 *   the `waiter` file, published by a link that fails while one exists, and
 *   a second waiter exits at once. A requester starts a waiter only when no
 *   live one holds the file.
 * - **One run a minute.** A run starts no sooner than `WAKE_SPACING_MS`
 *   after the last one started (`started`), so several requests within that
 *   minute start one run.
 * - **Counted at the start.** A run takes the requests present when it
 *   starts and removes only those when it ends; a request made while it runs
 *   stays pending, and one trailing run starts after the running one ends
 *   and the minute has passed.
 * - **A refused run is retried.** A run that ends `busy` (another tick
 *   holds its target, or a machine-wide lock it needs) keeps its requests and is
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
import { log } from "./log.ts";
import {
  decodeIdentity,
  encodeIdentity,
  isAliveSync,
  lockIdentity,
  type ProcessIdentity,
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
  return ownerGone(holder, "waiter claim") ? null : text;
}

/** Only a confirmed dead owner permits reclaiming; an unreadable owner keeps its claim. */
function ownerGone(holder: ProcessIdentity, claim: string): boolean {
  const verdict = isAliveSync(holder);
  if (!verdict.ok)
    log.warn(
      "the wake keeps its " +
        claim +
        " because liveness is indeterminate: " +
        verdict.failure.reason,
    );
  return verdict.ok && verdict.value.state === "dead";
}

/**
 * Hold `dir` for this process alone, as a waiter holds a wake: `false` while
 * a live process holds it, and a dead holder's claim is replaced. For a
 * caller that needs one process at a time, not a wake.
 */
export function takeHolder(dir: string): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return takeWaiter(dir);
}

/** Give up what `takeHolder` took. */
export function releaseHolder(dir: string): void {
  releaseWaiter(dir);
}

/** Take the waiter file for this process; `false` when a live waiter holds it. */
function takeWaiter(dir: string): boolean {
  const path = waiterPath(dir);
  const mine = encodeIdentity(lockIdentity());
  for (let attempt = 0; attempt < 2; attempt++) {
    if (publishIdentity(path, mine)) return true;
    const seen = readOptional(path);
    if (seen === null) continue;
    if (!reclaimWaiter(dir, seen, mine)) return false;
  }
  return false;
}

/**
 * Serialize stale removal with a mutex for this file content. A dead mutex
 * is superseded by a new generation, never unlinked by another reclaimer.
 * Every reclaimer rechecks the waiter under that mutex, so a paused one
 * cannot remove the live waiter another reclaimer published.
 */
function reclaimWaiter(dir: string, seen: string, mine: string): boolean {
  const id = createHash("sha256").update(seen).digest("hex").slice(0, 16);
  const deadline = performance.now() + 5000;
  for (let generation = 1; performance.now() < deadline; generation++) {
    const mutex = join(dir, "reclaim-" + id + "-" + generation);
    if (!publishIdentity(mutex, mine)) {
      const owner = decodeIdentity(readOptional(mutex));
      if (owner === null) return false;
      if (!ownerGone(owner, "reclaim mutex")) return false;
      continue;
    }
    try {
      if (readOptional(waiterPath(dir)) !== seen) return true;
      if (liveHolder(dir) !== null) return false;
      rmSync(waiterPath(dir), { force: true });
      return true;
    } finally {
      rmSync(mutex, { force: true });
    }
  }
  return false;
}

/** Publish an identity whole and exclusively, without exposing a partially written file. */
function publishIdentity(path: string, mine: string): boolean {
  const temporary = path + "." + randomBytes(8).toString("hex") + ".tmp";
  writeFileSync(temporary, mine, { flag: "wx", mode: 0o600 });
  try {
    linkSync(temporary, path);
    return true;
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") throw error;
    return false;
  } finally {
    rmSync(temporary, { force: true });
  }
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
  /** When the run can start: now, or when idle and spaced from the last start. */
  when: "now" | "soon";
}

/** The reasons the requests `names` give, in their order; one that is gone or names none is left out. */
export function requestReasons(
  dir: string,
  names: readonly string[],
): string[] {
  return names.flatMap((name) => {
    const text = readOptional(join(pendingDir(dir), name))?.trim() ?? "";
    return text === "" ? [] : [text.split("\n", 1)[0] as string];
  });
}

/**
 * Record a request in the wake at `dir`, with who asked and why (`reason`,
 * one line), and say whether a waiter must be started for it.
 */
export function requestWake(
  dir: string,
  clock: Pick<Clock, "now"> = systemClock,
  reason = "",
): Requested {
  const pending = pendingDir(dir);
  mkdirSync(pending, { recursive: true, mode: 0o700 });
  const now = clock.now();
  const name = `${String(now).padStart(15, "0")}-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(join(pending, name), reason.replace(/[\r\n]+/g, " "), {
    flag: "wx",
    mode: 0o600,
  });
  const waiting = liveHolder(dir) !== null;
  const last = lastStart(dir);
  const spaced = last === null || now - last >= WAKE_SPACING_MS;
  return { startWaiter: !waiting, when: !waiting && spaced ? "now" : "soon" };
}

/** What a waiter needs: the clock, the run, and the exit code that means the run was refused. */
export interface WaitDeps {
  clock?: Clock;
  /** Prepare the command before the spacing check; failure leaves requests pending. */
  prepare?(): Promise<Outcome<void, "unstarted">>;
  /** Launch without asynchronous preparation, then await its bounded exit; failure when it could not start. */
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
  const pending = pendingRequests(dir);
  if (pending.length === 0) return idle(dir);
  if (count.attempts >= WAKE_ATTEMPTS) {
    deps.note?.(
      `${count.attempts} runs started; ${pending.length} requests are left for the next wake`,
    );
    return "bounded";
  }
  const prepared = deps.prepare ? await deps.prepare() : undefined;
  if (prepared && !prepared.ok) {
    deps.note?.(`the run did not start: ${prepared.failure.reason}`);
    return "failed";
  }
  const due = (lastStart(dir) ?? Number.NEGATIVE_INFINITY) + WAKE_SPACING_MS;
  while (clock.now() < due) await clock.sleep(due - clock.now());
  const taken = pendingRequests(dir);
  count.attempts++;
  writeStarted(dir, clock.now());
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
  deps.note?.(`the run exited ${ran.value}, ${taking(dir, taken)}`);
  for (const name of taken)
    rmSync(join(pendingDir(dir), name), { force: true });
  return null;
}

/** The requests a run took, in words, with who asked and why where they say. */
function taking(dir: string, taken: readonly string[]): string {
  const reasons = requestReasons(dir, taken);
  const why = reasons.length === 0 ? "" : ` (${reasons.join("; ")})`;
  return `taking ${taken.length} requests${why}`;
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
