/**
 * Replacing a driver that still holds a drive's locks: `drive.ts <PR>
 * --take-over`, in the same clone. This file decides the takeover and stops
 * the holder; `takeover-complete.ts` finishes it once this driver holds the
 * locks. When no driver of this clone holds the drive, the pull request's
 * drive ledger decides (`ledger.ts`): a driver in another clone is admitted
 * on a heartbeat older than the lease window, and claimed on the pull
 * request once the locks are held; this tree's own driver that the ledger
 * still names running is `DEAD`, since it released its locks as it ended
 * without writing its stop, and what it left is this tree's, which this
 * driver settles as any re-arm does. This clone's driver in another tree is
 * refused with exit `2`, since what it left is that tree's, as is a ledger
 * that names no running driver.
 *
 * Admitted against exactly two holders, both decided by `drives.ts --doctor`
 * rather than by the caller: one whose verdict is `WEDGED` (a live driver,
 * progress older than the stall threshold, no pass process under it), and one
 * whose process is confirmed gone by its recorded identity with nothing left
 * in its working tree (no uncommitted changes, no unpushed commits, no
 * unconcluded git operation), or whose working tree no longer exists: nothing
 * in a vanished tree can be pushed or saved, so what it held unpushed is
 * already lost, and the takeover records the tree and says so. A lock reads
 * stale also when its process is alive with an old heartbeat, so staleness
 * alone never admits it. Against any other holder the takeover
 * refuses as exit `11` does, naming the verdict: a driver that is making
 * progress is never stopped, and a dead one's leftovers are pushed or
 * discarded by a person first, since a successor driving around them would
 * strand or overwrite them. A missing tree admits a dead holder and resumes from the
 * remote head; an existing unregistered tree or failed inspection still refuses.
 *
 * Everything that can refuse runs before the holder is stopped: the pass
 * command's check, the quota re-arm, the held batch's read, and this tree's
 * own lock unless the holder holds it. A wedged holder is stopped with the
 * identity check `drives.ts --stop` performs, through that command itself,
 * after its doctor row is read again, and only the acquisition that row
 * names (`--expect-started`). A refusal that still comes after the
 * stop (the attach, the PR lock) says the holder was stopped and prints the
 * plain re-arm command.
 */
import { ExitError, fail, isDigits, sleep } from "./../cli.ts";

import { git, helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";

import type { ClaimDiag } from "./../claim.ts";

import { accountHash, formatAccountIdentity } from "./../identity.ts";

import { worktreePathKey } from "./../state/actor.ts";

import type { HeldItem } from "./../state/schema.ts";

import { gatherWorktreeLeftovers } from "./../worktree-leftovers.ts";

import { drives, driveState } from "./paths.ts";

import { type DriveLock, liveHolder } from "./locks.ts";

import { armCommand, parseJson } from "./rearm.ts";

import { swallow } from "../../../../../shared/errors.ts";

import { isRecord } from "../../../../../shared/guards.ts";

import { SINGLE_INSTANCE_LOCK_EXIT } from "./settings.ts";

/** `drives.ts --stop --expect-started`: the lock is held by another acquisition. */
const STOP_OTHER_HOLDER_EXIT = 3;

import { registerCleanup } from "../../../../../shared/cleanup.ts";

import { type LedgerIdentity, ledgerTakeover } from "./ledger.ts";

/** One `drives.ts --doctor --json` row, as far as a takeover reads it. */
interface DoctorRowJson {
  kind: string;
  key: string;
  state: string;
  pid: number | null;
  host: string | null;
  hostId?: string | undefined;
  platform?: string | null;
  diag: ClaimDiag | null;
  /** The holder's process is confirmed gone by its recorded identity. */
  holderGone?: boolean;
  doctor: { verdict: string; reason: string; recovery: string | null } | null;
}

/** What an admitted takeover carries to `takeover-complete.ts`. */
export interface TakeoverPlan {
  verdict: "WEDGED" | "DEAD" | "STALE";
  fromActor: string | null;
  fromAccount: string | null;
  /** The holder's claim acquisition time: which instance is being replaced. */
  holderStarted: string | null;
  /** The held batch as it stood before anything was stopped. */
  held: HeldItem[];
  /** Admitted on another clone's stale ledger heartbeat: claimed on the PR. */
  crossClone?: true;
  /** The dead holder's missing working tree; shared Git storage may retain commits. */
  vanishedTree?: string;
}

/** The doctor's row for `pr`; `null` when no lock or state names it. */
export async function doctorRowFor(
  pr: string,
): Promise<DoctorRowJson | null | "unreadable"> {
  const res = await run(tsArgv(drives, ["--doctor", "--json"]), {
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (res.code !== 0) return "unreadable";
  const parsed = parseJson(res.stdout, "drives.ts --doctor --json");
  if (!isRecord(parsed) || !Array.isArray(parsed.rows)) return "unreadable";
  const row = parsed.rows.find(
    (r: unknown) => isRecord(r) && r.kind === "pr" && r.key === pr,
  );
  return isDoctorRow(row) ? row : null;
}

/** The fields of a doctor row a takeover reads, each checked. */
function isDoctorRow(v: unknown): v is DoctorRowJson {
  return (
    isRecord(v) &&
    typeof v.state === "string" &&
    (v.pid === null || typeof v.pid === "number") &&
    (v.host === null || typeof v.host === "string") &&
    (v.diag === null || isRecord(v.diag)) &&
    (v.holderGone === undefined || typeof v.holderGone === "boolean") &&
    (v.doctor === null ||
      (isRecord(v.doctor) && typeof v.doctor.verdict === "string"))
  );
}

function actorOf(diag: ClaimDiag | null): string | null {
  if (diag === null || diag.worktree === "") return null;
  try {
    return `wt-${worktreePathKey(diag.worktree)}`;
  } catch (err) {
    swallow(err, "the previous driver's tree no longer resolves");
    return null;
  }
}

function holderLines(row: DoctorRowJson): string[] {
  const lines = [
    `The holder: pid ${row.pid ?? "?"} on ${row.host || "this host"}, lock ${row.state}.`,
  ];
  if (row.diag !== null)
    lines.push(
      `It drives PR #${row.diag.pr} from ${row.diag.worktree} (started ${row.diag.started}); log ${row.diag.log}.`,
      `Account: ${formatAccountIdentity(row.diag.account)}.`,
    );
  lines.push(
    `Doctor verdict: ${row.doctor?.verdict ?? "UNKNOWN"}${row.doctor ? ` — ${row.doctor.reason}` : ""}.`,
  );
  return lines;
}

function refuse(pr: string, row: DoctorRowJson, ...why: string[]): never {
  return fail(
    SINGLE_INSTANCE_LOCK_EXIT,
    `drive.ts --take-over: refusing to take over PR #${pr}.`,
    ...holderLines(row),
    ...why,
  );
}

/** The held batch, read before anything is stopped; refuses when unreadable. */
async function heldSnapshot(pr: string): Promise<HeldItem[]> {
  const res = await run(tsArgv(driveState, ["held", pr]), {
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
  });
  const parsed =
    res.code === 0 ? parseJson(res.stdout, "drive-state.ts held") : null;
  if (!Array.isArray(parsed))
    return fail(
      1,
      `drive.ts --take-over: the held batch of PR #${pr} could not be read (drive-state.ts held exited ${res.code}); refusing to take over without knowing which holds to carry.`,
    );
  return parsed.filter(
    (h): h is HeldItem =>
      isRecord(h) &&
      typeof h.key === "string" &&
      (h.kind === "thread" || h.kind === "finding") &&
      typeof h.actor === "string",
  );
}

/**
 * Decide a takeover before anything is stopped or locked. Refuses (throws the
 * exit) for every holder the module header excludes.
 */
export async function decideTakeover(
  pr: string,
  ledger: LedgerIdentity | null,
): Promise<TakeoverPlan> {
  const row = await doctorRowFor(pr);
  if (row === "unreadable")
    fail(
      1,
      `drive.ts --take-over: could not read drives.ts --doctor for PR #${pr}; refusing to take over blind.`,
    );
  // No driver of this clone holds it: the pull request's drive ledger decides.
  if (row === null || row.state === "empty") return decideByLedger(pr, ledger);
  const verdict = row.doctor?.verdict ?? "UNKNOWN";
  let admitted: TakeoverPlan["verdict"];
  let vanished: string | null = null;
  if (row.state === "live" && verdict === "WEDGED") admitted = "WEDGED";
  else if (row.state === "stale") {
    vanished = await admitDeadHolder(pr, row);
    admitted = "DEAD";
  } else
    refuse(
      pr,
      row,
      "A takeover is admitted only against a WEDGED driver, or a dead one whose leftovers",
      "are pushed or discarded. Do not stop a driver that is making progress.",
    );
  return {
    verdict: admitted,
    fromActor: actorOf(row.diag),
    fromAccount: row.diag === null ? null : accountHash(row.diag.account),
    holderStarted: row.diag?.started ?? null,
    held: await heldSnapshot(pr),
    ...(vanished === null ? {} : { vanishedTree: vanished }),
  };
}

/**
 * Decide a takeover no lock of this clone holds by the pull request's drive
 * ledger: it may name a driver in another clone, or this clone's own that
 * ended without writing its stop. Refuses (throws the exit) otherwise.
 */
async function decideByLedger(
  pr: string,
  ledger: LedgerIdentity | null,
): Promise<TakeoverPlan> {
  const read =
    ledger === null
      ? ({ kind: "none" } as const)
      : await ledgerTakeover(pr, ledger);
  if (read.kind === "cross-clone") return read.plan;
  if (read.kind === "this-tree") return admitReleasedDriver(pr, read.actor);
  if (read.kind === "other-tree") {
    const tree = await treeOfActor(read.actor);
    fail(
      2,
      `drive.ts --take-over: no driver holds PR #${pr}'s lock, and its drive ledger names this clone's driver in another working tree (${tree === null ? `actor ${read.actor}, whose path is not among this clone's registered working trees` : tree}) as running: that driver ended without writing its stop, and what it left is that tree's, so this tree does not take it over.`,
      tree === null
        ? `Find the working tree whose \`git worktree list\` path hashes to ${read.actor} (a removed tree leaves nothing to re-arm from), re-arm it from there, or stop it there (drives.ts --stop) and re-arm it here.`
        : `Re-arm it from ${tree}, or stop it there (drives.ts --stop) and re-arm it here.`,
    );
  }
  return fail(
    2,
    `drive.ts --take-over: no driver holds PR #${pr}'s lock, and its drive ledger names no running driver in another clone, so there is nothing to take over.`,
    "Re-arm it without --take-over.",
  );
}

/**
 * The held batch as it stands after startup. Startup's ledger seeding may
 * replace the batch, so each entry present now is taken as it is now, with its
 * current metadata; an entry `planned` read before startup that is no longer
 * there is carried after them. A batch that cannot be read again stops the
 * takeover (exit `1`) rather than reconciling over a stale one.
 */
export async function heldAfterStartup(
  pr: string,
  planned: readonly HeldItem[],
): Promise<HeldItem[]> {
  const held = await heldSnapshot(pr);
  for (const item of planned)
    if (!held.some((h) => h.key === item.key && h.kind === item.kind))
      held.push(item);
  return held;
}

/**
 * The path of this clone's registered working tree that `actor` (`wt-` and the
 * path's hash) names, or `null` when none of `git worktree list` hashes to it.
 */
async function treeOfActor(actor: string): Promise<string | null> {
  const listed = await git(["worktree", "list", "--porcelain"], {
    timeoutSec: helperTimeoutSeconds(),
  });
  if (listed.code !== 0) return null;
  for (const line of listed.stdout.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    try {
      if (`wt-${worktreePathKey(path)}` === actor) return path;
    } catch (err) {
      swallow(err, "a registered working tree no longer resolves");
    }
  }
  return null;
}

/**
 * Admit this tree's own driver that the ledger still names running while it
 * holds no lock: it released its locks as it ended, without writing its
 * stop, and what it left is in this tree, which this driver settles as any
 * re-arm does. Nothing is stopped.
 */
async function admitReleasedDriver(
  pr: string,
  actor: string,
): Promise<TakeoverPlan> {
  console.error(
    `drive.ts --take-over: no driver holds PR #${pr}'s lock, but its drive ledger names this tree's driver (${actor}) as running: it ended without writing its stop, so it is DEAD; taking the drive over in its tree.`,
  );
  return {
    verdict: "DEAD",
    fromActor: actor,
    fromAccount: null,
    holderStarted: null,
    held: await heldSnapshot(pr),
  };
}

/**
 * Admit a stale holder confirmed gone with nothing left to save, or refuse;
 * returns its tree when that no longer exists, else `null`.
 */
async function admitDeadHolder(
  pr: string,
  row: DoctorRowJson,
): Promise<string | null> {
  requireProcessGone(pr, row);
  const vanished = await requireNoLeftovers(pr, row);
  const gone = `drive.ts --take-over: PR #${pr}'s previous driver (pid ${row.pid ?? "?"}) is gone`;
  console.error(
    vanished === null
      ? `${gone} and left nothing in its tree; taking the drive over.`
      : `${gone} and its tree (${vanished}) is missing; local work may need recovery. Inspect branch refs and reflogs in shared Git storage for recoverable commits before redoing work; taking the drive over and resuming from the remote head.`,
  );
  return vanished;
}

/** A stale lock admits a takeover only when its process is confirmed gone. */
function requireProcessGone(pr: string, row: DoctorRowJson): void {
  // Judged by the holder's recorded identity, as the lock's own recovery
  // judges it (`holderGone`): a pid that answers no signal, or now belongs to
  // a process with another start time or boot. A claim from another machine
  // or pid namespace is never confirmed gone.
  if (row.holderGone === true) return;
  refuse(
    pr,
    row,
    "Its lock is stale, but its process is not confirmed gone: a driver alive with an old",
    "heartbeat is not a dead one. Wait for its doctor verdict, or stop it with --stop first.",
  );
}

/**
 * Refuses a dead holder whose tree holds leftovers or cannot be inspected;
 * returns the tree when it no longer exists, else `null` for a clean one.
 */
async function requireNoLeftovers(
  pr: string,
  row: DoctorRowJson,
): Promise<string | null> {
  const tree = row.diag?.worktree ?? "";
  const leftovers =
    tree === "" ? null : await gatherWorktreeLeftovers(tree, process.cwd());
  if (leftovers === "missing") return tree;
  if (leftovers === null)
    refuse(
      pr,
      row,
      `Its previous driver is gone, but its working tree ${tree === "" ? "is not recorded" : `(${tree}) could not be inspected`} for leftovers.`,
      "Check it by hand, push or discard what it holds, then take over.",
    );
  const found = [
    leftovers.uncommitted ? "uncommitted changes" : "",
    leftovers.unpushed ? "unpushed commits" : "",
    leftovers.unconcludedOp !== null
      ? `an unconcluded git operation (${leftovers.unconcludedOp})`
      : "",
  ].filter((s) => s !== "");
  if (found.length > 0)
    refuse(
      pr,
      row,
      `Its previous driver is gone (DEAD_WITH_LEFTOVERS) and ${tree} still holds ${found.join(", ")}.`,
      `Push or discard them first (git -C ${JSON.stringify(tree)} status --short), then take over.`,
    );
  return null;
}

let stoppedNotice: Disposable | null = null;
let takeoverSettled = false;

/**
 * Said on any exit after the holder was stopped and before the takeover was
 * recorded: nothing drives the PR now, and the plain re-arm picks it up.
 */
function announceStoppedOnExit(pr: string, rearm: string): void {
  stoppedNotice = registerCleanup(() => {
    if (takeoverSettled) return;
    console.error(
      `drive.ts --take-over: PR #${pr}'s previous driver WAS STOPPED, but this driver stopped before taking the drive over, so nothing drives the PR now. Re-arm it:`,
    );
    console.error(`  ${rearm}`);
  });
}

/** The holder was not stopped after all; the exit notice would be false. */
function withdrawStoppedNotice(): void {
  stoppedNotice?.[Symbol.dispose]();
  stoppedNotice = null;
}

/** The takeover is recorded; the exit notice is no longer owed. */
export function settleTakeover(): void {
  takeoverSettled = true;
  withdrawStoppedNotice();
}

/** Stop a WEDGED holder, once its doctor row still says so. */
async function stopWedgedHolder(
  plan: TakeoverPlan,
  pr: string,
  prLock: DriveLock,
  rearm: string,
): Promise<void> {
  // Read again right before the stop: a holder that spawned a pass since the
  // decision is no longer wedged, and is not stopped mid-pass.
  const row = await doctorRowFor(pr);
  if (row === "unreadable" || row === null)
    fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: PR #${pr}'s doctor row could not be read again before the stop; not stopping its driver.`,
    );
  const started = row.diag?.started ?? null;
  if (
    row.state !== "live" ||
    row.doctor?.verdict !== "WEDGED" ||
    started === null ||
    started !== plan.holderStarted
  )
    refuse(
      pr,
      row,
      "It changed since the takeover was decided, or its claim names no acquisition time to bind the stop to; not stopping it.",
    );
  console.error(
    `drive.ts --take-over: PR #${pr}'s driver is WEDGED; stopping it through drives.ts --stop.`,
  );
  for (const line of holderLines(row)) console.error(`  ${line}`);
  // Bound to the diagnosed acquisition: `--stop` refuses (exit 3) a holder
  // that acquired the lock after this row was read, so a healthy successor
  // of an exited wedged driver is never the one stopped.
  const stop = await run(
    tsArgv(drives, ["--stop", pr, "--expect-started", started]),
    {
      stdout: "inherit",
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
    },
  );
  if (stop.code === STOP_OTHER_HOLDER_EXIT) {
    refuse(
      pr,
      row,
      "Another driver acquired the lock before the stop; not stopping it.",
    );
  }
  if (stop.code !== 0)
    fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: drives.ts --stop ${pr} exited ${stop.code}; the holder may still be running. Not taking over.`,
    );
  // The stopped driver releases its locks on the way out; a forced one leaves
  // a lock whose holder is gone, which the acquisition recovers.
  const deadline = Date.now() + helperTimeoutSeconds() * 1000;
  while (liveHolder(prLock.stateDir, prLock.name) !== null) {
    if (Date.now() >= deadline)
      fail(
        SINGLE_INSTANCE_LOCK_EXIT,
        `drive.ts --take-over: PR #${pr}'s lock still reads live after the stop; not taking over.`,
      );
    await sleep(0.25);
  }
  // Only now is the stop witnessed: a refusal before this point says the
  // holder may still be running, and the exit must not claim otherwise.
  announceStoppedOnExit(pr, rearm);
}

/**
 * Take this tree's lock around the takeover: before stopping the holder, so a
 * refusal leaves it running, unless the holder itself holds this tree, which
 * only its stop can free.
 */
export async function holdTreeAroundTakeover(
  plan: TakeoverPlan | null,
  pr: string,
  locks: { tree: DriveLock; pr: DriveLock },
  holdTree: () => Promise<void>,
  rearm: string,
): Promise<void> {
  const stopFirst =
    plan !== null &&
    plan.verdict === "WEDGED" &&
    plan.holderStarted !== null &&
    liveHolder(locks.tree.stateDir, locks.tree.name)?.diag?.started ===
      plan.holderStarted;
  if (plan !== null && stopFirst)
    await stopWedgedHolder(plan, pr, locks.pr, rearm);
  await holdTree();
  if (plan !== null && plan.verdict === "WEDGED" && !stopFirst)
    await stopWedgedHolder(plan, pr, locks.pr, rearm);
}

/** The PR this driver was armed for, and the pass command it runs. */
export interface OwnPass {
  pr: string;
  agent: readonly string[];
}

/**
 * Explain an exit-11 refusal: the holder's doctor verdict and, when a
 * takeover would be admitted, the command — with this driver's own pass
 * command when the holder drives the same PR, since that command names its
 * PR. Called with the refusal already printed; never changes the exit.
 */
export async function explainHolder(
  lock: DriveLock,
  driveTs: string,
  botsOnly: boolean,
  own: OwnPass,
): Promise<void> {
  const holder = liveHolder(lock.stateDir, lock.name);
  const pr = holder?.diag?.pr ?? "";
  if (!isDigits(pr)) return;
  const row = await doctorRowFor(pr);
  if (row === null || row === "unreadable") {
    console.error("Its doctor verdict could not be read (drives.ts --doctor).");
    return;
  }
  const verdict = row.doctor?.verdict ?? "UNKNOWN";
  console.error(
    `Its doctor verdict: ${verdict}${row.doctor ? ` — ${row.doctor.reason}` : ""}.`,
  );
  if (verdict === "WEDGED") {
    console.error("It is wedged, so a takeover is admitted:");
    const agent = pr === own.pr ? own.agent : [];
    console.error(
      `  ${armCommand(driveTs, pr, botsOnly, " --take-over", agent)}`,
    );
  } else {
    console.error(
      "Do not stop a driver that is making progress; a takeover is admitted only once it is WEDGED or dead.",
    );
  }
}

/** Run `fn`, and on an exit-11 refusal explain the holder before rethrowing. */
export async function explainingRefusal<T>(
  lock: DriveLock,
  driveTs: string,
  botsOnly: boolean,
  own: OwnPass,
  fn: () => T,
): Promise<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ExitError && e.code === SINGLE_INSTANCE_LOCK_EXIT)
      await explainHolder(lock, driveTs, botsOnly, own).catch(() => undefined);
    throw e;
  }
}
