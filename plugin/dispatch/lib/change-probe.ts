/**
 * The change probe: what wakes a repository's tick when something changed
 * on the forge (a review, a comment, a label a person adds, a push, a
 * check that ends, a merge, a close), rather than waiting for the next
 * sweep. Once a minute its own timer runs `jig dispatch probe --apply`,
 * which reads every repository the machine file dispatches in one forge
 * call (`change-probe-github.ts`), compares what it read with what the last
 * probe saw, and wakes (`wake-tick.ts`, under `shared/wake.ts`'s rule) only
 * the repositories where something changed. A minute with no change starts
 * no tick. A probe that cannot read the forge wakes nothing, keeps what it
 * saw and says why; the sweep runs on its own timer whatever the probe does.
 *
 * What it compares, per pull request (`slug#number`):
 *
 * - **Updated.** Each pull request the forge reports updated inside the
 *   window, with its `updatedAt`. One the last probes did not see, or saw at
 *   an earlier time, changed. The window starts `PROBE_OVERLAP_MS` before
 *   the last probe, so a change the forge's search index reports late is
 *   still found, and the probe keeps every time it saw inside the window,
 *   so nothing it saw already counts twice.
 * - **Checks.** Each open pull request's head commit and the state of its
 *   checks. One whose head or state differs from the last probe's changed.
 *
 * A first probe, with nothing seen before, reads the last minute.
 *
 * What it keeps is one file, `probe/state.json` under the dispatcher's
 * state directory, written only by a probe that woke what it found (a run
 * without `--apply` writes nothing): the time of the last probe, what it saw,
 * and each checkout's forge repository, read again once a day.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Clock, systemClock } from "../../shared/clock.ts";
import { errnoCode } from "../../shared/errors.ts";
import { isRecord } from "../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { stateRoot } from "../receipts.ts";
import type { MachineConfig } from "./machine-config.ts";

/** How far before the last probe a probe's window starts. */
export const PROBE_OVERLAP_MS = 10 * 60_000;
/** The window of a probe with nothing seen before. */
export const FIRST_WINDOW_MS = 60_000;
/** The longest window after a gap in the probes: past it, the sweep has read the repositories. */
const MAX_WINDOW_MS = 60 * 60_000;
/** How long a checkout's forge repository is kept before it is read again. */
const SLUG_TTL_MS = 24 * 3_600_000;

/** A pull request the forge reports updated inside the window. */
export interface ChangedPr {
  slug: string;
  number: number;
  updatedAt: string;
}

/** An open pull request's head commit and the state of its checks (`NONE` without any). */
export interface OpenPr {
  slug: string;
  number: number;
  head: string;
  checks: string;
}

/** What one probe read from the forge. */
export interface ProbeRead {
  changed: ChangedPr[];
  open: OpenPr[];
  /** The repositories the signed-in account cannot see. */
  unseen: string[];
  /** The calls made, and what the forge charged for them in its own units. */
  calls: number;
  cost: number;
  remaining: number | null;
}

/** The forge reads the probe makes; GitHub's is `githubProbeForge`. */
export interface ProbeForge {
  /** The forge repository (`owner/name`) the checkout at `path` belongs to. */
  slug(path: string): Promise<Outcome<string, "unreadable">>;
  /** The pull requests of `slugs` updated at or after `since`, and every open one's checks. */
  search(
    slugs: readonly string[],
    since: string,
  ): Promise<Outcome<ProbeRead, "unreadable">>;
}

/** What a probe keeps for the next one. */
export interface ProbeState {
  v: 1;
  /** When the last probe that woke what it found read the forge, in epoch milliseconds. */
  probedAt: number;
  /** Each pull request seen updated inside the window: `slug#number` to its `updatedAt`. */
  updated: Record<string, string>;
  /** Each open pull request's head and checks: `slug#number` to `<head> <state>`. */
  checks: Record<string, string>;
  /** Each checkout's forge repository, and when it was read. */
  slugs: Record<string, { slug: string; at: number }>;
}

/** The probe's directory under the dispatcher's state directory: its state file, and its job's launcher and logs. */
export function probeRoot(root = stateRoot()): string {
  return join(root, "probe");
}

const statePath = (dir: string) => join(dir, "state.json");

function stringMap(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, v]) => typeof v === "string")
    ? (Object.fromEntries(entries) as Record<string, string>)
    : null;
}

/** The kept state; `null` when there is none. One that does not read is a failure, for the caller to start over from. */
export function readProbeState(
  dir: string,
): Outcome<ProbeState | null, "unreadable"> {
  let text: string;
  try {
    text = readFileSync(statePath(dir), "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return ok(null);
    return failed("unreadable", `${statePath(dir)} does not read`, error);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return failed("unreadable", `${statePath(dir)} is not JSON`);
  }
  const updated = isRecord(value) ? stringMap(value.updated) : null;
  const checks = isRecord(value) ? stringMap(value.checks) : null;
  const slugs = isRecord(value) && isRecord(value.slugs) ? value.slugs : null;
  if (
    !isRecord(value) ||
    value.v !== 1 ||
    typeof value.probedAt !== "number" ||
    updated === null ||
    checks === null ||
    slugs === null ||
    !Object.values(slugs).every(
      (s) =>
        isRecord(s) && typeof s.slug === "string" && typeof s.at === "number",
    )
  )
    return failed("unreadable", `${statePath(dir)} is not a probe's state`);
  return ok({
    v: 1,
    probedAt: value.probedAt,
    updated,
    checks,
    slugs: slugs as ProbeState["slugs"],
  });
}

/** Keep `state`, whole: written beside the file and renamed over it. */
function writeProbeState(
  dir: string,
  state: ProbeState,
): Outcome<void, "unwritten"> {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = `${statePath(dir)}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath(dir));
    return ok(undefined);
  } catch (error) {
    return failed("unwritten", `${statePath(dir)} was not written`, error);
  }
}

/** Where a probe at `now` starts reading, in epoch milliseconds. */
function windowStart(previous: ProbeState | null, now: number): number {
  if (previous === null) return now - FIRST_WINDOW_MS;
  return Math.max(previous.probedAt - PROBE_OVERLAP_MS, now - MAX_WINDOW_MS);
}

/** An ISO time to the second, as the forge's search takes it. */
export function searchTime(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

type Changes = Map<string, string[]>;

/** What changed, by repository, and what the next probe compares with. */
interface Decision {
  /** Each repository that changed, with what changed on it. */
  changes: Changes;
  updated: Record<string, string>;
  checks: Record<string, string>;
}

function note(changes: Changes, slug: string, what: string): void {
  changes.set(slug, [...(changes.get(slug) ?? []), what]);
}

/**
 * The pull requests updated since the last probe saw them, into `changes`,
 * and the update times the next probe compares with: those inside its
 * window, which starts `PROBE_OVERLAP_MS` before `now`.
 */
function updatedSince(
  seen: Record<string, string>,
  read: readonly ChangedPr[],
  now: number,
  changes: Changes,
): Record<string, string> {
  const floor = now - PROBE_OVERLAP_MS;
  const kept = Object.entries(seen).filter(([, at]) => Date.parse(at) >= floor);
  const updated: Record<string, string> = Object.fromEntries(kept);
  for (const pr of read) {
    const key = `${pr.slug}#${pr.number}`;
    const at = Date.parse(pr.updatedAt);
    const before = seen[key] === undefined ? null : Date.parse(seen[key]);
    if (before !== null && at <= before) continue;
    note(changes, pr.slug, `#${pr.number} updated ${pr.updatedAt}`);
    if (at >= floor) updated[key] = pr.updatedAt;
  }
  return updated;
}

/** The open pull requests whose head or checks moved since the last probe, into `changes`; and each one's now. */
function checksMoved(
  seen: Record<string, string>,
  read: readonly OpenPr[],
  changes: Changes,
): Record<string, string> {
  const checks: Record<string, string> = {};
  for (const pr of read) {
    const key = `${pr.slug}#${pr.number}`;
    checks[key] = `${pr.head} ${pr.checks}`;
    const before = seen[key];
    if (before === undefined || before === checks[key]) continue;
    note(
      changes,
      pr.slug,
      before.split(" ")[0] === pr.head
        ? `#${pr.number} checks ${pr.checks}`
        : `#${pr.number} head ${pr.head.slice(0, 7)}`,
    );
  }
  return checks;
}

/** Compare `read` with what the last probe saw; with nothing seen before, everything the window holds changed. */
function decide(
  previous: ProbeState | null,
  read: ProbeRead,
  now: number,
): Decision {
  const changes: Changes = new Map();
  const updated = updatedSince(
    previous?.updated ?? {},
    read.changed,
    now,
    changes,
  );
  const checks = checksMoved(previous?.checks ?? {}, read.open, changes);
  return { changes, updated, checks };
}

/** One repository the probe would wake: its checkouts, what changed, and what each wake did. */
export interface ProbeChange {
  slug: string;
  paths: string[];
  what: string[];
  /** With `--apply`: per checkout, how the wake went, or why it failed. */
  woke?: Record<string, string>;
}

/** What one probe did. */
export interface ProbeReport {
  status: "off" | "probed";
  /** The repositories it read. */
  probed: string[];
  since: string | null;
  /** Checkouts whose forge repository did not read, and why: their changes wait for the sweep. */
  unresolved: { path: string; reason: string }[];
  unseen: string[];
  changes: ProbeChange[];
  /** Why the kept state was started over, when it did not read. */
  restarted?: string;
  /** Why what this probe saw was not kept, when it was not: the next probe compares with the last state kept. */
  unkept?: string;
  calls: number;
  cost: number;
  remaining: number | null;
}

/** What a probe needs: the clock, the forge, how it wakes a tick, and where it keeps its state. */
export interface ProbeDeps {
  clock?: Pick<Clock, "now">;
  forge: ProbeForge;
  /** Wakes the tick of the checkout at `path`, saying why; with `--apply` only. */
  wake(path: string, reason: string): Promise<Outcome<string, "failed">>;
  dir?: string;
}

/** The forge repository of each checkout, from the kept state while fresh, else read again. */
async function slugs(
  paths: readonly string[],
  kept: ProbeState["slugs"],
  forge: ProbeForge,
  now: number,
): Promise<{
  slugs: ProbeState["slugs"];
  unresolved: ProbeReport["unresolved"];
}> {
  const resolved: ProbeState["slugs"] = {};
  const unresolved: ProbeReport["unresolved"] = [];
  await Promise.all(
    paths.map(async (path) => {
      const cached = kept[path];
      if (cached !== undefined && now - cached.at < SLUG_TTL_MS) {
        resolved[path] = cached;
        return;
      }
      const slug = await forge.slug(path);
      if (slug.ok) resolved[path] = { slug: slug.value, at: now };
      else unresolved.push({ path, reason: slug.failure.reason });
    }),
  );
  return { slugs: resolved, unresolved };
}

/** Wake each change's checkouts, one after another; whether every wake recorded. */
async function wakeAll(
  changes: readonly ProbeChange[],
  wake: ProbeDeps["wake"],
): Promise<boolean> {
  let woken = true;
  for (const change of changes) {
    change.woke = {};
    for (const path of change.paths) {
      const woke = await wake(
        path,
        `probe: ${change.slug} ${change.what.join(", ")}`,
      );
      change.woke[path] = woke.ok ? woke.value : woke.failure.reason;
      woken &&= woke.ok;
    }
  }
  return woken;
}

const EMPTY: ProbeReport = {
  status: "off",
  probed: [],
  since: null,
  unresolved: [],
  unseen: [],
  changes: [],
  calls: 0,
  cost: 0,
  remaining: null,
};

/** The probe's report of `read`, from `since`, with each changed repository's checkouts. */
function reported(
  base: ProbeReport,
  since: string,
  read: ProbeRead,
  changes: Changes,
  slugs: ProbeState["slugs"],
): ProbeReport {
  const paths = Object.keys(slugs);
  return {
    ...base,
    since,
    unseen: read.unseen,
    calls: read.calls,
    cost: read.cost,
    remaining: read.remaining,
    changes: [...changes].map(([slug, what]) => ({
      slug,
      what,
      paths: paths.filter((path) => slugs[path]?.slug === slug),
    })),
  };
}

/**
 * One probe over the repositories the machine file dispatches (those with a
 * stage enabled). With `apply`, it wakes each changed repository's tick and
 * keeps what it saw; without, it only says what it would wake. A forge that
 * does not read is a failure: nothing is woken and the kept state stays.
 */
export async function probe(
  machine: MachineConfig,
  apply: boolean,
  deps: ProbeDeps,
): Promise<Outcome<ProbeReport, "unreadable">> {
  if (!machine.changeProbe) return ok(EMPTY);
  const dir = deps.dir ?? probeRoot();
  const now = (deps.clock ?? systemClock).now();
  const kept = readProbeState(dir);
  const previous = kept.ok ? kept.value : null;
  const paths = machine.repositories
    .filter((r) => r.stages.length > 0)
    .map((r) => r.path);
  const found = await slugs(paths, previous?.slugs ?? {}, deps.forge, now);
  const probed = [...new Set(Object.values(found.slugs).map((s) => s.slug))];
  const base: ProbeReport = {
    ...EMPTY,
    status: "probed",
    probed,
    unresolved: found.unresolved,
    ...(kept.ok ? {} : { restarted: kept.failure.reason }),
  };
  if (probed.length === 0) return ok(base);
  const since = searchTime(windowStart(previous, now));
  const read = await deps.forge.search(probed, since);
  if (!read.ok) return read;
  const decision = decide(previous, read.value, now);
  const report = reported(
    base,
    since,
    read.value,
    decision.changes,
    found.slugs,
  );
  if (!apply) return ok(report);
  // A wake that failed leaves the state as it was, so the next probe wakes it again.
  if (!(await wakeAll(report.changes, deps.wake)))
    return ok({ ...report, unkept: "a wake did not record" });
  const written = writeProbeState(dir, {
    v: 1,
    probedAt: now,
    updated: decision.updated,
    checks: decision.checks,
    slugs: found.slugs,
  });
  return ok(
    written.ok ? report : { ...report, unkept: written.failure.reason },
  );
}
