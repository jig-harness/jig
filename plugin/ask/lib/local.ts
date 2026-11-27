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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
  KnownRepository,
  RepositoryChoices,
} from "../../shared/address.ts";
import { consumerRoot } from "../../shared/consumer.ts";
import { swallow } from "../../shared/errors.ts";
import { isRecord } from "../../shared/guards.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  ChildFailure,
  run,
  tsArgv,
  type RunOptions,
  type RunResult,
} from "../../shared/proc.ts";
import { FORGE_ACCOUNTING_UNAVAILABLE } from "../../shared/trace.ts";
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
import type { CiHoldDiagnosis } from "../../skills/drive-pr/scripts/lib/ci-hold-diagnosis.ts";
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
  const machine = readMachineConfig();
  return machine.ok
    ? machine
    : failed(
        "unreadable",
        `the dispatch file does not read: ${machine.failure.reason}`,
        machine.failure.cause,
      );
}

/** The forge repository a checkout's git remote names, read locally; `null` when it names none. */
function slugAt(path: string): string | null {
  const url = remoteUrl(path);
  const repo = url === null ? null : repoFromRemote(url);
  return repo === null ? null : `${repo.owner}/${repo.name}`;
}

/**
 * Whether this machine's dispatch file lists `repo` as one it owns, so its
 * tick reads the repository's answers; why it cannot be told when the
 * dispatch file does not read, or no owned checkout names `repo` and one
 * names no repository.
 */
export function ownsRepository(repo: string): Outcome<boolean, "unreadable"> {
  const machine = machineFile();
  if (!machine.ok) return machine;
  const owned = (machine.value?.repositories ?? []).filter((r) => r.owner);
  const slugs = owned.map((r) => ({ path: r.path, slug: slugAt(r.path) }));
  if (slugs.some((s) => s.slug?.toLowerCase() === repo.toLowerCase()))
    return ok(true);
  const unnamed = slugs.find((s) => s.slug === null);
  return unnamed === undefined
    ? ok(false)
    : failed(
        "unreadable",
        `the git remote of ${unnamed.path}, a checkout the dispatch file says this machine owns, names no repository`,
      );
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
  let read: Outcome<LogRow[]> = state.ok ? ok([]) : state;
  if (state.ok) {
    const what = `the outcome log does not read${behindNote(state.value)}`;
    const rows = attempt("unreadable", what, () =>
      rowsFor(repo, target, root, state.value.db),
    );
    read = !rows.ok
      ? rows
      : rows.value.ok
        ? rows.value
        : failed("unreadable", `${what}: ${rows.value.failure.reason}`);
  }
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
  doctor: {
    verdict: string;
    reason: string;
    recovery: string | null;
    ciHold?: CiHoldDiagnosis;
  } | null;
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
    doctor: doctor === null ? null : doctorOf(doctor),
    worktree: text(diag.worktree),
    generation: typeof diag.generation === "number" ? diag.generation : null,
    account,
    mailbox: text(diag.mailbox),
    started: text(diag.started),
  };
}

/** Parse the doctor's optional diagnostic fields without guessing at missing evidence. */
function doctorOf(
  doctor: Record<string, unknown>,
): NonNullable<DriveRow["doctor"]> {
  return {
    verdict: text(doctor.verdict) ?? "UNKNOWN",
    reason: text(doctor.reason) ?? "",
    recovery: text(doctor.recovery),
    ...(isRecord(doctor.ciHold) ? { ciHold: ciHoldOf(doctor.ciHold) } : {}),
  };
}

function ciHoldOf(hold: Record<string, unknown>): CiHoldDiagnosis {
  return {
    driver:
      hold.driver === "alive" || hold.driver === "dead"
        ? hold.driver
        : "unknown",
    actor: text(hold.actor),
    started: text(hold.started),
    ledgerGeneration:
      typeof hold.ledgerGeneration === "number" ? hold.ledgerGeneration : null,
    generation: typeof hold.generation === "number" ? hold.generation : null,
    driverReason:
      text(hold.driverReason) ?? "driver liveness could not be read",
    head: text(hold.head),
    label: text(hold.label),
    held: typeof hold.held === "boolean" ? hold.held : null,
    review:
      hold.review === "converged" || hold.review === "pending"
        ? hold.review
        : "unknown",
    reason: text(hold.reason) ?? "CI hold evidence could not be read",
    recovery: text(hold.recovery),
    worktree: text(hold.worktree),
  };
}

/** Read the local driver lock or the drive doctor's diagnosis under its own source deadline. */
async function driveRow(
  reading: Reading,
  path: string,
  pr: number,
  mode: "lock" | "diagnosis",
): Promise<Outcome<DriveRow | null, "unreadable">> {
  const sec = reading.sourceSec();
  if (sec === 0)
    return failed("unreadable", `deadline exceeded: ${PAST_DEADLINE}`);
  const argv = listingArgv(mode, pr);
  const options: RunOptions = {
    cwd: path,
    // This reader uses the checkout's state rather than a drive's pinned tree.
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== "DRIVE_PR_WORKTREE",
      ),
    ),
    timeoutSec: sec,
    stderr: "pipe",
  };
  const result =
    mode === "lock"
      ? ok(await run(argv, options))
      : await runWithForgeAccounting(reading, argv, options);
  if (!result.ok) return result;
  const r = result.value;
  return r.code === 0 ? parseListing(r.stdout, pr) : listingFailure(argv, r);
}

function listingArgv(mode: "lock" | "diagnosis", pr: number): string[] {
  const args = ["--json", "--pr", String(pr)];
  return tsArgv(
    drivesScript(),
    mode === "lock" ? ["--lock-only", ...args] : args,
  );
}

function listingFailure(
  argv: string[],
  r: RunResult,
): Outcome<never, "unreadable"> {
  if (r.code === 4)
    // The listing declined: reading would have migrated or imported into the drive's database, or the doctor's forge client names no login.
    return failed(
      "unreadable",
      r.stderr.replace(/^drives-read-only\.ts: /, "").trim() ||
        "the drive's database is not current, and a driver's next run brings it forward",
    );
  const cause = new ChildFailure(argv, r);
  const reason = `${r.timedOut ? "deadline exceeded" : "listing failed"}: the drive's listing exited ${r.code}`;
  swallow(cause, reason);
  return failed("unreadable", reason, cause);
}

function parseListing(
  stdout: string,
  pr: number,
): Outcome<DriveRow | null, "unreadable"> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch (cause) {
    return failed("unreadable", "the drive's listing printed no JSON", cause);
  }
  if (!isRecord(value) || !Array.isArray(value.rows))
    return failed(
      "unreadable",
      "the drive's listing printed an invalid row list",
    );
  return ok(findDriveRow(value.rows, pr));
}

function findDriveRow(rows: unknown[], pr: number): DriveRow | null {
  const row = rows.find(
    (value): value is Record<string, unknown> =>
      isRecord(value) && value.kind === "pr" && value.key === String(pr),
  );
  return row === undefined ? null : rowOf(row);
}

/** The doctor can make forge calls, including before a deadline kills its listing. */
async function runWithForgeAccounting(
  reading: Reading,
  argv: string[],
  options: RunOptions,
) {
  const directory = attempt(
    "unreadable",
    "could not prepare forge call accounting for the drive diagnosis",
    () => mkdtempSync(join(tmpdir(), "jig-ask-forge-")),
  );
  if (!directory.ok) return directory;
  const accounting = directory.value;
  const countFile = join(accounting, "calls");
  let r: Awaited<ReturnType<typeof run>>;
  let accountingUnavailable = false;
  try {
    r = await run(argv, {
      ...options,
      env: { ...options.env, JIG_FORGE_CALL_COUNT_FILE: countFile },
    });
    accountingUnavailable = r.stderr.includes(FORGE_ACCOUNTING_UNAVAILABLE);
  } finally {
    try {
      const calls = existsSync(countFile) ? readFileSync(countFile).length : 0;
      for (let i = 0; i < calls; i++) reading.forgeCall();
      if (accountingUnavailable)
        reading.note({
          record: "drive forge call accounting",
          read: false,
          detail: "forge call count is incomplete: accounting unavailable",
        });
    } catch (err) {
      swallow(err, "accounting failures must not discard the drive listing");
      reading.note({
        record: "drive forge call accounting",
        read: false,
        detail: "forge call count is unavailable",
      });
    }
    try {
      rmSync(accounting, { recursive: true, force: true });
    } catch (err) {
      swallow(
        err,
        "temporary accounting cleanup must not discard the drive listing",
      );
    }
  }
  return ok(r);
}

/** The doctor's verdict on a drive, in words, with the recovery it gives. */
function doctorDetail(row: DriveRow | null): { detail?: string } {
  const doctor = row?.doctor;
  if (doctor == null) return {};
  const recovery =
    doctor.recovery === null ? "" : `; recovery: ${doctor.recovery}`;
  return { detail: `doctor: ${doctor.verdict}: ${doctor.reason}${recovery}` };
}

/** The drive as its own listing in a checkout of the repository on this machine reads it, noted in the sources. */
export async function localDriveRow(
  reading: Reading,
  checkout: string | null,
  pr: number,
  mode: "diagnose" | "lock-only",
): Promise<DriveRow | null> {
  if (checkout === null) {
    reading.note({
      record: "drive-lock",
      read: false,
      local: true,
      detail: "no checkout of the repository on this machine",
    });
    return null;
  }
  const lock = await localDriveLock(reading, checkout, pr);
  if (mode === "lock-only") return lock.ok ? lock.value : null;
  return localDriveDiagnosis(reading, checkout, pr, lock);
}

async function localDriveLock(reading: Reading, checkout: string, pr: number) {
  const row = await driveRow(reading, checkout, pr, "lock");
  reading.note({
    record: "drive-lock",
    read: row.ok,
    local: true,
    detail: row.ok
      ? `driver lock: ${row.value?.lock ?? "empty"}`
      : row.failure.reason,
  });
  return row;
}

async function localDriveDiagnosis(
  reading: Reading,
  checkout: string,
  pr: number,
  lock: Outcome<DriveRow | null, "unreadable">,
): Promise<DriveRow | null> {
  const diagnosis = await driveRow(reading, checkout, pr, "diagnosis");
  reading.note({
    record: "drive-diagnosis",
    read: diagnosis.ok,
    local: true,
    ...(diagnosis.ok
      ? doctorDetail(diagnosis.value)
      : { detail: diagnosis.failure.reason }),
  });
  if (!lock.ok) return null;
  return diagnosis.ok ? withDiagnosis(lock.value, diagnosis.value) : lock.value;
}

const EMPTY_DRIVER = {
  lock: "empty",
  host: null,
  started: null,
  generation: null,
};
const DRIVER_FIELDS = ["lock", "host", "started", "generation"] as const;

/** Attach the verdict only when both reads describe the same driver. */
function withDiagnosis(
  lock: DriveRow | null,
  diagnosis: DriveRow | null,
): DriveRow | null {
  if (diagnosis === null) return lock;
  const driver = lock ?? EMPTY_DRIVER;
  if (!DRIVER_FIELDS.every((field) => driver[field] === diagnosis[field]))
    return lock;
  return { ...(lock ?? diagnosis), doctor: diagnosis.doctor };
}
