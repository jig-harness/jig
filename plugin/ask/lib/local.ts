/**
 * What `jig ask` reads on this machine: the dispatch file's repositories and
 * the checkout it runs in, the dispatcher's state database (launch records,
 * the outcome log, the newest tick's line) through the dispatcher's own
 * readers, and a drive's own records through the drive's listing
 * (`drives.ts --json`), which classifies each drive the way its doctor does
 * and writes nothing. None of it is created or migrated here when it does
 * not exist yet: a machine that never dispatched has no launch records, and
 * the answer says so.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  KnownRepository,
  RepositoryChoices,
} from "../../shared/address.ts";
import { consumerRoot } from "../../shared/consumer.ts";
import { isRecord } from "../../shared/guards.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { run, tsArgv } from "../../shared/proc.ts";
import {
  readMachineConfig,
  type MachineConfig,
} from "../../dispatch/lib/machine-config.ts";
import { type ReadRecord, readLaunches } from "../../dispatch/lib/launches.ts";
import { type LogRow, rowsFor } from "../../dispatch/lib/log.ts";
import { hostOf } from "../../dispatch/lib/shared-launches.ts";
import { statePath } from "../../dispatch/lib/state.ts";
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
  "drives.ts",
);

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

/** This machine's launch records that `keep` accepts, with their state, or why they do not read. */
export async function launchesWhere(
  root: string,
  keep: (r: ReadRecord) => boolean,
): Promise<
  Outcome<{ records: ReadRecord[]; unreadable: string[] }, "unreadable">
> {
  try {
    const { records, unreadable } = await readLaunches(root);
    return ok({ records: records.filter(keep), unreadable });
  } catch (error) {
    return failed(
      "unreadable",
      `the launch records do not read: ${error instanceof Error ? error.message : String(error)}`,
    );
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
  limit?: number,
): LogRow[] {
  const read = attempt("unreadable", "the outcome log does not read", () =>
    rowsFor(repo, target, root, limit),
  );
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
  const read = attempt("unreadable", "", () => hostOf(root));
  return read.ok ? read.value : null;
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
 * at `path` reads it (`drives.ts --json`: its driver lock and the doctor's
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
  const r = await run(tsArgv(DRIVES, ["--json"]), {
    cwd: path,
    // The listing reads the tree a drive pass pins over its directory; this one reads the checkout's.
    env: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k !== "DRIVE_PR_WORKTREE"),
    ),
    timeoutSec: sec,
    stderr: "pipe",
  });
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
