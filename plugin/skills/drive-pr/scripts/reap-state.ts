#!/usr/bin/env bun
/**
 * Reaper for the files drive-pr keeps beside its database in a clone's state
 * directory (`~/.local/state/jig/drive-pr/<clone key>/`): the driver logs,
 * the kept answers and long pass notices, the arm output, a driver's process
 * registry; and the files an earlier release kept there, which the database
 * imported once (`lib/state/import.ts`) and left in place. Also expires trace
 * days older than 14 days. Meant to run from a scheduled (weekly) sweep.
 *
 * What lives in the database (the drive state, the locks, the leases, the
 * claims) is not this script's: a release leaves no row behind, and a PR's
 * state row stays, small, for the morning report and a re-arm.
 *
 * Families retired whole or kept whole:
 *
 * - `pr:<PR>`: a PR's files. RETIRED only when the PR is MERGED (or GitHub no
 *   longer knows it), no live session lease is on it, and nothing in the
 *   family was touched for `--min-age-days` (default 7). A merged PR cannot
 *   be driven again, so no driver resumes into its files. A CLOSED but
 *   unmerged PR can be reopened at any time, so it is kept; an answer this
 *   cannot interpret (a failed `gh` call) keeps it too.
 * - `imported:<clone>`: the earlier release's files (its state files, leases,
 *   lock directories and their tombstones, markers). RETIRED once the clone's
 *   import is older than `IMPORTED_RETENTION_DAYS`, which leaves a person a
 *   month to inspect them; kept before that, and kept when the clone was
 *   never imported. The files the import could not read are never retired:
 *   they may be the only copy of what they held. A dry run reads the import
 *   record without opening the database for writing, so it creates and
 *   imports nothing.
 * - `quarantine:<clone>`: displaced legacy locks and recovery gates, reported
 *   with count and bytes. RETIRED once no earlier-release writer shows in the
 *   clone: no legacy lock or recovery gate is present, none of its state,
 *   lease, driver or claim files was written in the last 24 hours, and no
 *   entry (or anything under one) is younger than that. Independent of
 *   whether or when the clone was imported (`lib/state/quarantine.ts`).
 *
 * A name no family recognises is never removed. Every gate fails
 * CLOSED: an entry that cannot be read keeps its family.
 *
 * Usage:
 *   bun <skill-dir>/scripts/reap-state.ts            # dry run (default)
 *   bun <skill-dir>/scripts/reap-state.ts --delete   # act
 *   bun <skill-dir>/scripts/reap-state.ts --json     # machine-readable report
 *
 * Flags:
 *   --delete            Actually retire. Without it, nothing on disk changes
 *                       and the report says what would happen.
 *   --min-age-days N    The idle guard on a PR's files (default 7, 1 to 365).
 *   --json              Emit the report as JSON instead of prose.
 *
 * Exit codes: 0 = ran to completion (including "nothing to do"), 1 = the
 * state directory could not be read, a removal did not complete, or (with
 * `--delete`) another `--delete` run held the reaper's lock, 2 = bad
 * arguments.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { reapTraceDays } from "../../../shared/trace.ts";
import { fail, isDigits, runMain } from "./lib/cli.ts";
import { ghCall } from "./lib/proc.ts";
import { cloneFile, REPORT_MEMORY } from "./lib/state/artifacts.ts";
import { driveDb, peekImport } from "./lib/state/db.ts";
import { FORMER_QUARANTINE, isFormerFile } from "./lib/state/import.ts";
import { peekLiveLeasesFor } from "./lib/state/lease.ts";
import { createLock, LockAcquireTimeoutError } from "./lib/state/lock.ts";
import { judgeQuarantine } from "./lib/state/quarantine.ts";
import { peekResolvedStateDir, resolveStateDir } from "./lib/state/store.ts";

const DEFAULT_MIN_AGE_DAYS = 7;
const MAX_MIN_AGE_DAYS = 365;

/** How long the files an import read stay for a person to inspect. */
export const IMPORTED_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
const GH_CONCURRENCY = 6;

interface Args {
  readonly del: boolean;
  readonly json: boolean;
  readonly minAgeDays: number;
}

export function parseArgs(argv: readonly string[]): Args {
  let del = false;
  let json = false;
  let minAgeDays = DEFAULT_MIN_AGE_DAYS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--delete") {
      del = true;
    } else if (a === "--json") {
      json = true;
    } else if (a === "--min-age-days") {
      const v = argv[++i] ?? "";
      const parsed = isDigits(v) ? Number.parseInt(v, 10) : Number.NaN;
      if (
        !Number.isSafeInteger(parsed) ||
        parsed < 1 ||
        parsed > MAX_MIN_AGE_DAYS
      ) {
        fail(
          2,
          `reap-state.ts: --min-age-days must be an integer between 1 and ${MAX_MIN_AGE_DAYS}, got '${v}'.`,
          "It is the idle guard stacked on the lifecycle predicate; 0 would remove",
          "the only bound that survives a lifecycle answer being wrong.",
        );
      }
      minAgeDays = parsed;
    } else {
      fail(2, `reap-state.ts: unknown argument '${a}'.`);
    }
  }
  return { del, json, minAgeDays };
}

type PrLifecycle = "open" | "retired" | "closed" | "unknown";

/**
 * PR `pr`'s lifecycle: `retired` when merged or unknown to GitHub (a state
 * can only have been created for a PR that existed, so one GitHub no longer
 * knows cannot come back), `closed` when closed unmerged, `unknown` for any
 * answer this cannot interpret.
 */
async function prLifecycle(pr: string): Promise<PrLifecycle> {
  const r = await ghCall(["pr", "view", pr, "--json", "state"], {
    stderr: "pipe",
  });
  if (r.code !== 0) {
    return /no pull requests found|could not resolve to a pull\s*request/i.test(
      `${r.stderr}`,
    )
      ? "retired"
      : "unknown";
  }
  let state: unknown;
  try {
    state = (JSON.parse(r.stdout) as { state?: unknown }).state;
  } catch {
    return "unknown";
  }
  if (state === "MERGED") return "retired";
  if (state === "CLOSED") return "closed";
  if (state === "OPEN") return "open";
  return "unknown";
}

async function prLifecycles(prs: string[]): Promise<Map<string, PrLifecycle>> {
  const out = new Map<string, PrLifecycle>();
  const queue = [...prs];
  const worker = async (): Promise<void> => {
    for (;;) {
      const pr = queue.shift();
      if (pr === undefined) return;
      out.set(pr, await prLifecycle(pr));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(GH_CONCURRENCY, queue.length) }, worker),
  );
  return out;
}

interface Family {
  id: string;
  names: string[];
}

interface Verdict {
  family: Family;
  action: "retire" | "keep";
  reason: string;
  bytes?: number | null;
}

/** Newest mtime across a family, or `null` when one member cannot be read. */
function newestMtimeMs(
  stateDir: string,
  names: readonly string[],
): number | null {
  let newest = 0;
  for (const n of names) {
    try {
      newest = Math.max(newest, statSync(join(stateDir, n)).mtimeMs);
    } catch {
      return null;
    }
  }
  return newest;
}

/** Group the clone directory's entries by family; the rest are unrecognised. */
function classify(
  names: readonly string[],
  clone: string,
): { families: Map<string, Family>; unrecognised: string[] } {
  const families = new Map<string, Family>();
  const unrecognised: string[] = [];
  const add = (id: string, name: string): void => {
    const f = families.get(id) ?? { id, names: [] };
    f.names.push(name);
    families.set(id, f);
  };
  for (const name of names) {
    const file = cloneFile(name);
    if (FORMER_QUARANTINE.test(name)) add(`quarantine:${clone}`, name);
    else if (file !== null) add(`pr:${file.pr}`, name);
    else if (isFormerFile(name)) add(`imported:${clone}`, name);
    else if (name !== REPORT_MEMORY) unrecognised.push(name);
  }
  return { families, unrecognised };
}

/** Report order must not depend on the directory's read order. */
function byId(a: { id: string }, b: { id: string }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** A PR family's verdict, by the predicate in the header. */
function judgePr(
  stateDir: string,
  family: Family,
  lifecycle: PrLifecycle,
  minAgeMs: number,
): Verdict {
  const pr = family.id.slice("pr:".length);
  if (lifecycle !== "retired")
    return {
      family,
      action: "keep",
      reason:
        lifecycle === "closed"
          ? "the PR is closed but not merged, and can be reopened"
          : lifecycle === "open"
            ? "the PR is open"
            : "the PR's state could not be read",
    };
  const leases = peekLiveLeasesFor(stateDir, pr);
  if (leases === null)
    return {
      family,
      action: "keep",
      reason: "its leases cannot be read without writing the database",
    };
  if (leases.length > 0)
    return { family, action: "keep", reason: "a live session lease is on it" };
  const newest = newestMtimeMs(stateDir, family.names);
  if (newest === null)
    return { family, action: "keep", reason: "an entry could not be read" };
  if (Date.now() - newest < minAgeMs)
    return {
      family,
      action: "keep",
      reason: `touched within the last ${Math.round(minAgeMs / DAY_MS)} day(s)`,
    };
  return {
    family,
    action: "retire",
    reason: "the PR is merged, no lease is live, and its files are idle",
  };
}

/**
 * The imported family's verdict: retired once the import is past its
 * retention, except the files the import could not read, which are the only
 * copy of what they held and stay until a person removes them.
 */
function judgeImported(stateDir: string, family: Family): Verdict {
  const record = peekImport(stateDir);
  if (record === null)
    return { family, action: "keep", reason: "this clone was never imported" };
  const age = Date.now() - Date.parse(record.at);
  if (!Number.isFinite(age) || age < IMPORTED_RETENTION_DAYS * DAY_MS)
    return {
      family,
      action: "keep",
      reason: `imported ${record.at}, within the ${IMPORTED_RETENTION_DAYS}-day retention`,
    };
  const unread = new Set(record.skipped);
  const names = family.names.filter((n) => !unread.has(n));
  const left = family.names.length - names.length;
  return {
    family: { ...family, names },
    action: "retire",
    reason: `imported ${record.at}, past the ${IMPORTED_RETENTION_DAYS}-day retention${left === 0 ? "" : `; ${left} file(s) the import could not read stay for a person`}`,
  };
}

/** Judge each family under its own retention rule. */
function judgeFamily(
  stateDir: string,
  family: Family,
  lifecycles: ReadonlyMap<string, PrLifecycle>,
  minAgeMs: number,
): Verdict {
  if (family.id.startsWith("pr:"))
    return judgePr(
      stateDir,
      family,
      lifecycles.get(family.id.slice(3)) ?? "unknown",
      minAgeMs,
    );
  if (family.id.startsWith("quarantine:"))
    return { family, ...judgeQuarantine(stateDir, family.names) };
  return judgeImported(stateDir, family);
}

/** A visible family line, including quarantines kept by a safety guard. */
function familyLine(v: Verdict, del: boolean): string {
  const action =
    v.action === "keep" ? "kept" : del ? "RETIRED" : "would retire";
  const bytes =
    v.bytes === undefined ? "" : `, ${v.bytes ?? "unreadable"} bytes`;
  return `  ${action} ${v.family.id} (${v.family.names.length} entries${bytes}) — ${v.reason}`;
}

function reportEntry(v: Verdict) {
  return {
    id: v.family.id,
    entries: v.family.names.length,
    ...(v.bytes === undefined ? {} : { bytes: v.bytes }),
    reason: v.reason,
  };
}

/** Remove a family's entries; the names that could not be removed. */
function retire(stateDir: string, family: Family): string[] {
  const failed: string[] = [];
  if (family.id.startsWith("quarantine:")) {
    // Revalidate at deletion: the verdict was reached earlier.
    const again = judgeQuarantine(stateDir, family.names);
    if (again.action !== "retire")
      return [`${family.id}: kept at deletion — ${again.reason}`];
  }
  for (const name of family.names) {
    try {
      rmSync(join(stateDir, name), { recursive: true, force: true });
    } catch (e) {
      failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return failed;
}

/** The report for a clone with no state directory yet; the exit code. */
function reportNoStateDir(
  args: Args,
  stateDir: string | null,
  traceDays: ReturnType<typeof reapTraceDays>,
): number {
  if (args.json)
    console.log(
      JSON.stringify(
        {
          stateDir,
          exists: false,
          entries: 0,
          retire: [],
          keep: [],
          entriesRemoved: 0,
          traceDays: traceDays.days,
          failures: traceDays.failures,
        },
        null,
        2,
      ),
    );
  else console.log("reap-state.ts: no state directory yet — nothing to reap.");
  return traceDays.failures.length === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const stateDir = args.del
    ? await resolveStateDir()
    : await peekResolvedStateDir();
  const traceDays = reapTraceDays(args.del);
  const failures = [...traceDays.failures];
  let names: string[] | null = null;
  if (stateDir !== null) {
    try {
      names = readdirSync(stateDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        console.error(
          `reap-state.ts: cannot enumerate ${stateDir}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 1;
      }
    }
  }
  if (stateDir === null || names === null)
    return reportNoStateDir(args, stateDir, traceDays);

  const lock = args.del
    ? createLock(stateDir, "reap-state", "reap-state.ts (delete)", "reap-state")
    : null;
  if (lock !== null) {
    try {
      await lock.acquire(3);
    } catch (e) {
      if (!(e instanceof LockAcquireTimeoutError)) throw e;
      console.error(
        "reap-state.ts: another --delete run holds the reaper's lock; not racing it.",
      );
      return 1;
    }
  }
  try {
    // Importing is a write, so only a run that acts does it; a dry run reads
    // the import record as it is.
    if (args.del) driveDb(stateDir);
    const clone = basename(stateDir);
    const { families, unrecognised } = classify(names, clone);
    const prs = [...families.keys()]
      .filter((id) => id.startsWith("pr:"))
      .map((id) => id.slice("pr:".length));
    const lifecycles = await prLifecycles(prs);
    const minAgeMs = args.minAgeDays * DAY_MS;
    const verdicts = [...families.values()].map((family) =>
      judgeFamily(stateDir, family, lifecycles, minAgeMs),
    );
    let removed = 0;
    const retired = verdicts.filter((v) => v.action === "retire");
    if (args.del)
      for (const v of retired) {
        const failed = retire(stateDir, v.family);
        removed += v.family.names.length - failed.length;
        failures.push(...failed.map((f) => `${v.family.id}: ${f}`));
      }
    const report = {
      stateDir,
      exists: true,
      entries: names.length,
      families: families.size,
      retire: retired.map(reportEntry).sort(byId),
      keep: verdicts
        .filter((v) => v.action === "keep")
        .map(reportEntry)
        .sort(byId),
      untouched: { unrecognised: unrecognised.length },
      applied: args.del,
      entriesRetirable: retired.reduce((n, v) => n + v.family.names.length, 0),
      entriesRemoved: args.del ? removed : 0,
      traceDays: traceDays.days,
      failures,
    };
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(
        `reap-state.ts: ${names.length} entries in ${stateDir}, ${families.size} families`,
      );
      for (const v of verdicts.filter(
        (v) => v.action === "retire" || v.bytes !== undefined,
      ))
        console.log(familyLine(v, args.del));
      console.log(
        `  kept ${report.keep.length} family/families; untouched: ${unrecognised.length} unrecognised entry/entries`,
      );
      console.log(
        `  ${args.del ? "expired" : "would expire"} ${traceDays.days.length} trace day(s)`,
      );
      if (!args.del)
        console.log("  DRY RUN — nothing changed. Pass --delete to act.");
      for (const f of failures) console.log(`  FAILED ${f}`);
    }
    return failures.length === 0 ? 0 : 1;
  } finally {
    lock?.dispose();
  }
}

if (import.meta.main) {
  runMain("reap-state.ts", main);
}
