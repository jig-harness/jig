/**
 * A system that did not answer is not asked again in the same run, and the
 * next run asks it once before it reads on.
 *
 * A run (the dispatcher's tick) turns holding on with `holdUnanswered`,
 * naming the file the holds outlive the run in. From then, every request a
 * transport sends through `guarded`:
 *
 * - to a system that met `unreachable` or `server-fault` earlier in the run
 *   (after the transport's own retry) is not sent: it fails at once as that
 *   class, naming the first failure;
 * - to a system the previous run held is the probe when it is the first:
 *   it is sent alone, the requests that come while it is out wait for its
 *   answer, and they are sent only when it is answered; a probe that meets
 *   the same failure holds the system for this run too.
 *
 * Any answer, a refusal or an absence included, says the system answers,
 * and releases the hold kept in the file. A process that never turns
 * holding on (a pass, a person's skill) sends every request as it asks.
 * The file is a hint: one that cannot be read or written holds nothing.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { swallow } from "../errors.ts";
import { isRecord } from "../guards.ts";
import {
  failureOf,
  type OutboundFailure,
  outboundFailure,
  unanswered,
} from "./failure.ts";

/** A system held in the file: when, and the failure that held it. */
interface Kept {
  at: string;
  reason: string;
}

interface Book {
  path: string;
  /** Systems held in this run, with the failure that held each. */
  held: Map<string, OutboundFailure>;
  /** Systems the file holds from an earlier run that no request of this run has been answered by. */
  earlier: Map<string, Kept>;
  /** The probe out to each system, which the requests that come meanwhile wait for. */
  probes: Map<string, Promise<void>>;
  now: () => number;
}

let book: Book | null = null;

function readKept(path: string): Map<string, Kept> {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) return new Map();
    const out = new Map<string, Kept>();
    for (const [system, kept] of Object.entries(value))
      if (
        isRecord(kept) &&
        typeof kept.at === "string" &&
        typeof kept.reason === "string"
      )
        out.set(system, { at: kept.at, reason: kept.reason });
    return out;
  } catch (err) {
    swallow(err, "a hold file that does not read holds nothing");
    return new Map();
  }
}

/** Write the holds that outlive the run: those of this run, and those of an earlier run not yet answered. */
function writeKept(b: Book): void {
  const value: Record<string, Kept> = Object.fromEntries(b.earlier);
  for (const [system, failure] of b.held)
    value[system] = {
      at: new Date(b.now()).toISOString(),
      reason: failure.reason,
    };
  try {
    mkdirSync(dirname(b.path), { recursive: true });
    const temporary = `${b.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value)}\n`);
    renameSync(temporary, b.path);
  } catch (err) {
    swallow(err, "a hold that cannot be kept is asked again next run");
  }
}

/** Hold the systems that do not answer for the rest of this process's run, keeping the holds in `path` for the next. */
export function holdUnanswered(
  path: string,
  now: () => number = Date.now,
): void {
  book = {
    path,
    held: new Map(),
    earlier: readKept(path),
    probes: new Map(),
    now,
  };
}

/** Stop holding: every request is sent as asked. */
export function stopHolding(): void {
  book = null;
}

/** The systems held in this run, with the failure that held each. */
export function heldSystems(): ReadonlyMap<string, OutboundFailure> {
  return book?.held ?? new Map();
}

/** The failure a held system's request fails with. */
function heldFailure(system: string, first: OutboundFailure): OutboundFailure {
  return outboundFailure(
    first.code,
    `${system} did not answer earlier in this run, so it is not asked again before the next: ${first.reason}`,
  );
}

/** Note what one request met: a failure that holds the system, or an answer that releases an earlier hold. */
function settle(
  b: Book,
  system: string,
  failure: OutboundFailure | null,
): void {
  if (failure !== null && unanswered(failure.code)) {
    if (!b.held.has(system)) {
      b.held.set(system, failure);
      b.earlier.delete(system);
      writeKept(b);
    }
    return;
  }
  if (b.earlier.delete(system)) writeKept(b);
}

/** Wait for `probe`, or throw `signal`'s reason when it aborts first. */
async function untilProbed(
  probe: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return probe;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([probe, aborted]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

/**
 * `send` to `system`, unless this run holds it: then `refuse` gives what
 * the request answers instead. `answered` says what an answer stands for;
 * a throw is read through `failureOf`, recorded and rethrown. A request
 * waiting for another's probe stops waiting when `signal` aborts, throwing
 * its reason, and is not sent after it.
 */
export async function guarded<T>(
  system: string,
  send: () => Promise<T>,
  answered: (answer: T) => OutboundFailure | null,
  refuse: (failure: OutboundFailure) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const b = book;
  if (b === null) return send();
  for (;;) {
    const held = b.held.get(system);
    if (held !== undefined) return refuse(heldFailure(system, held));
    const probe = b.probes.get(system);
    if (probe === undefined) break;
    await untilProbed(probe, signal);
  }
  signal?.throwIfAborted();
  // The first request to a system an earlier run held is its probe.
  const probe = b.earlier.has(system) ? Promise.withResolvers<void>() : null;
  if (probe !== null) b.probes.set(system, probe.promise);
  try {
    const answer = await send();
    settle(b, system, answered(answer));
    return answer;
  } catch (error) {
    settle(b, system, failureOf(error));
    throw error;
  } finally {
    if (probe !== null) {
      b.probes.delete(system);
      probe.resolve();
    }
  }
}
