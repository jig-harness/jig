/**
 * What `jig ask` reads on this machine: the dispatch file's repositories and
 * the checkout it runs in, the dispatcher's state database (launch records,
 * the outcome log, the newest tick's line) through the dispatcher's own
 * readers over a read-only connection, and a drive's own records through
 * the drive's listing (`drives-read-only.ts`), which classifies
 * each drive the way its doctor does. None of it is created, migrated or
 * written here: a machine that never dispatched has no launch records, and
 * the answer says so; a database an older schema holds is read as far as
 * that schema allows, or named in the sources as not read until its owner's
 * next run brings it forward.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  KnownRepository,
  RepositoryChoices,
} from "../../shared/address.ts";
import { consumerRoot } from "../../shared/consumer.ts";
import { swallow } from "../../shared/errors.ts";
import { isRecord } from "../../shared/guards.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run, tsArgv } from "../../shared/proc.ts";
import {
  databaseInstance,
  type ReadOnlyDatabase,
} from "../../shared/records/db.ts";
import { digest } from "../../shared/records/writer.ts";
import {
  readMachineConfig,
  type MachineConfig,
} from "../../dispatch/lib/machine-config.ts";
import { type ReadRecord, readLaunches } from "../../dispatch/lib/launches.ts";
import { type LogRow, rowsFor } from "../../dispatch/lib/log.ts";
import { readOnlyStateDb, statePath } from "../../dispatch/lib/state.ts";
import { stateRoot } from "../../dispatch/receipts.ts";
import {
  remoteUrl,
  repoFromRemote,
} from "../../skills/do-item/scripts/lib/tracker/github/refs.ts";
import { PAST_DEADLINE, type Reading } from "./reading.ts";

/** The drive's own listing, a sibling skill's script. */
const DRIVES = resolve(
  import.meta.dir,
  "..",
  "..",
  "skills",
  "drive-pr",
  "scripts",
  "drives-read-only.ts",
);

/** The listing script: the drive's, unless a test names another. */
function drivesScript(): string {
  return process.env.JIG_ASK_DRIVES_SCRIPT || DRIVES;
}

/** The dispatch file, or why it does not read; `null` when there is none. */
export function machineFile(): Outcome<MachineConfig | null, "unreadable"> {
  return attempt("unreadable", "the dispatch file does not read", () =>
    readMachineConfig(),
  );
}

/** The forge repository a checkout's git remote names, read locally; `null` when it names none. */
function slugAt(path: string): string | null {
  const url = remoteUrl(path);
  const repo = url === null ? null : repoFromRemote(url);
  return repo === null ? null : `${repo.owner}/${repo.name}`;
}

/** What a written repository resolves against: the dispatch file's repositories and the checkout this runs in. */
export function repositoryChoices(
  machine: MachineConfig | null,
): RepositoryChoices & { checkoutPath: string | null } {
  const known: KnownRepository[] = (machine?.repositories ?? []).map((r) => ({
    slug: slugAt(r.path),
    path: r.path,
  }));
  const root = consumerRoot();
  const checkout = existsSync(resolve(root, ".git")) ? slugAt(root) : null;
  return { known, checkout, checkoutPath: checkout === null ? null : root };
}

/** A checkout of `repo` on this machine: the one this runs in, else one the dispatch file lists; `null` when there is none. */
export function checkoutOf(
  repo: string,
  choices: ReturnType<typeof repositoryChoices>,
): string | null {
  if (choices.checkout === repo && choices.checkoutPath !== null)
    return choices.checkoutPath;
  return choices.known.find((r) => r.slug === repo)?.path ?? null;
}

/** The dispatcher's state directory when its database exists; `null` on a machine that never dispatched. */
export function dispatcherRoot(): string | null {
  const root = stateRoot();
  return existsSync(statePath(root)) ? root : null;
}

/**
 * The dispatcher's state database under `root`, read-only, with the reason
 * it cannot be used otherwise; the caller closes it. A database behind this
 * plugin's schema is returned as it is.
 */
function openState(root: string): Outcome<ReadOnlyDatabase, "unreadable"> {
  const opened = readOnlyStateDb(root);
  if (!opened.ok) return failed("unreadable", opened.failure.reason);
  return opened.value === null
    ? failed("unreadable", "there is no dispatcher database")
    : ok(opened.value);
}

/** What a failed read of a database behind this plugin's schema adds: the owner brings it forward. */
function behindNote(state: ReadOnlyDatabase): string {
  return state.behind
    ? ` (the dispatcher's database is at schema version ${state.version}; its next run brings it forward)`
    : "";
}

/** This machine's launch records that `keep` accepts, with their state, or why they do not read. */
export async function launchesWhere(
  root: string,
  keep: (r: ReadRecord) => boolean,
): Promise<
  Outcome<{ records: ReadRecord[]; unreadable: string[] }, "unreadable">
> {
  const state = openState(root);
  if (!state.ok) return state;
  try {
    const { records, unreadable } = await readLaunches(
      root,
      undefined,
      state.value.db,
    );
    return ok({ records: records.filter(keep), unreadable });
  } catch (error) {
    return failed(
      "unreadable",
      `the launch records do not read: ${error instanceof Error ? error.message : String(error)}${behindNote(state.value)}`,
    );
  } finally {
    state.value.db.close();
  }
}

/**
 * One piece of work's rows in this machine's outcome log (`target` as the
 * rows name it), noted in the sources; none when the log does not read.
 */
export function outcomeRows(
  reading: Reading,
  root: string,
  repo: string,
  target: string,
): LogRow[] {
  const state = openState(root);
  const read = state.ok
    ? attempt(
        "unreadable",
        `the outcome log does not read${behindNote(state.value)}`,
        () => rowsFor(repo, target, root, state.value.db),
      )
    : state;
  if (state.ok) state.value.db.close();
  reading.note(
    read.ok
      ? { record: "dispatch-outcome", read: true, local: true }
      : {
          record: "dispatch-outcome",
          read: false,
          local: true,
          detail: read.failure.reason,
        },
  );
  return read.ok ? read.value : [];
}

/** This host as its launch claims name it, or `null` when that cannot be read. */
export function ourHost(root: string): string | null {
  const state = openState(root);
  if (!state.ok) return null;
  try {
    const instance = databaseInstance(state.value.db);
    // A database from before it recorded its instance names no host; none is guessed.
    return instance === "" ? null : digest(instance);
  } catch (error) {
    swallow(error, "the dispatcher database's instance could not be read");
    return null;
  } finally {
    state.value.db.close();
  }
}

/** One drive as the drive's own listing reads it. */
export interface DriveRow {
  /** The driver lock: `live`, `stale`, `empty`, `contested` or `unreadable`. */
  lock: string;
  host: string | null;
  doctor: { verdict: string; reason: string; recovery: string | null } | null;
  /** The driver's claim: its worktree, its generation, its account and its mailbox. */
  worktree: string | null;
  generation: number | null;
  account: string | null;
  mailbox: string | null;
  started: string | null;
}

const text = (v: unknown): string | null =>
  typeof v === "string" && v !== "" ? v : null;

function rowOf(v: Record<string, unknown>): DriveRow {
  const diag = isRecord(v.diag) ? v.diag : {};
  const doctor = isRecord(v.doctor) ? v.doctor : null;
  const account = isRecord(diag.account) ? text(diag.account.account) : null;
  return {
    lock: text(v.state) ?? "unreadable",
    host: text(v.host),
    doctor:
      doctor === null
        ? null
        : {
            verdict: text(doctor.verdict) ?? "UNKNOWN",
            reason: text(doctor.reason) ?? "",
            recovery: text(doctor.recovery),
          },
    worktree: text(diag.worktree),
    generation: typeof diag.generation === "number" ? diag.generation : null,
    account,
    mailbox: text(diag.mailbox),
    started: text(diag.started),
  };
}

/**
 * The drive of pull request `pr` as the drive's own listing in the checkout
 * at `path` reads it (`drives-read-only.ts`, which runs `drives.ts --json` over a
 * database that is already current: its driver lock and the doctor's
 * verdict on it, which it reads without writing); `null` when that clone
 * holds no driver lock for it.
 */
export async function driveRow(
  reading: Reading,
  path: string,
  pr: number,
): Promise<Outcome<DriveRow | null, "unreadable">> {
  const sec = reading.sourceSec();
  if (sec === 0) return failed("unreadable", PAST_DEADLINE);
  const r = await run(tsArgv(drivesScript(), ["--json"]), {
    cwd: path,
    // The listing reads the tree a drive pass pins over its directory; this one reads the checkout's.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "DRIVE_PR_WORKTREE"),
    ),
    timeoutSec: sec,
    stderr: "pipe",
  });
  if (r.code === 4)
    // The listing declined because reading would have migrated or imported into the drive's database.
    return failed(
      "unreadable",
      r.stderr.replace(/^drives-read-only\.ts: /, "").trim() ||
        "the drive's database is not current, and a driver's next run brings it forward",
    );
  if (r.code !== 0)
    return failed(
      "unreadable",
      `the drive's listing exited ${r.code}${r.timedOut ? " at its deadline" : ""}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return failed("unreadable", "the drive's listing printed no JSON");
  }
  const rows =
    isRecord(parsed) && Array.isArray(parsed.rows) ? parsed.rows : [];
  const row = rows.find(
    (v): v is Record<string, unknown> =>
      isRecord(v) && v.kind === "pr" && v.key === String(pr),
  );
  return ok(row === undefined ? null : rowOf(row));
}
