#!/usr/bin/env bun
import {
  prepareOperatorStop,
  takeExpectStarted,
  takeReason,
  requireStopOptions,
} from "./lib/stop-options.ts";
/**
 * drives.ts — the operator's answer to "who is driving what, from where?"
 *
 * A drive is routinely armed as a background child of a session that ends
 * long before the drive does (do-item's "Arm the drive" step), so the
 * running fleet is invisible by default: the locks name a pid, the pid has no
 * pane, and the refusal a second start meets ("another driver already holds
 * the … lock") names a process the operator has no window into. This command
 * is that window. Scope is ONE clone's rows of the drive's database — the
 * same clone key every driver shares, so every linked worktree of a clone
 * sees the same fleet; a different clone has a fleet of its own.
 *
 * READ-ONLY over lock state, by design: a stale lock is the next `acquire`'s
 * to recover, and a listing that also swept would be a second writer to a
 * protocol built around exactly one (`drive.ts` § Single-instance locking).
 * Locks are interpreted by exactly the rule recovery uses — `lib/claim.ts`,
 * shared with the writer — so this listing can never call a lock live that
 * recovery would take over, or vice versa. `--stop` sends the driver a
 * mailbox `stop` addressed to its generation; it never removes the lock.
 *
 * Modes:
 *   drives.ts                list every drive lock (human-readable); a LIVE
 *                            PR row whose progress has gone stale past
 *                            `lib/doctor.ts`'s threshold prints the stall
 *                            inline — a heartbeat proves the
 *                            process is alive, not that it is progressing
 *   drives.ts --json         the same LOCK rows, as JSON — every PR-kind row
 *                            also carries `doctor: {verdict, reason,
 *                            recovery}`, the same classification `--doctor`
 *                            prints in human form. Same POPULATION as the plain
 *                            listing: locks only, which is what a
 *                            status board polling this mode consumes.
 *   drives.ts --doctor [--pr N]  one classified verdict per drive in the state
 *                            universe — HEALTHY, WEDGED,
 *                            DEAD, DEAD_WITH_LEFTOVERS, QUOTA_PARKED, NEEDS_HUMAN
 *                            or UNKNOWN, plus a recovery command where one
 *                            exists. See `lib/doctor.ts` for the classifier
 *                            and its precedence order; first reconciles confirmed-dead local acquisitions (terminal-states.md).
 *
 *                            A WIDER POPULATION than the two modes above,
 *                            and that difference is the point: `drive.ts`
 *                            releases its locks on every normal exit,
 *                            INCLUDING both quota-park exits and the HITL
 *                            park, so a parked drive has no lock left while
 *                            its state — carrying the `quotaPark` and
 *                            `parked` this sweep exists to report —
 *                            survives. This mode's population is therefore
 *                            locks UNION states; a state-only drive appears
 *                            as a `state: 'empty'` row with no `diag`. Combines with
 *                            --json, which then carries that same wider
 *                            population; mutually exclusive with
 *                            --here/--stop like they are with each other.
 *   drives.ts --here         banner IFF a live driver holds THIS worktree's
 *                            lock; positively-empty prints nothing. Read
 *                            failures print a warning rather than nothing —
 *                            the SessionStart hook consumes this mode, and
 *                            its silence must only ever mean "checked, and
 *                            clear", never "could not check".
 *   drives.ts --stop <PR>    Verify the live driver's creation identity,
 *                            then send it a mailbox `stop` addressed to the
 *                            driver generation its claim names, marked `now`
 *                            (`lib/state/mailbox-stop.ts`). The driver stops
 *                            its pass tree at once, acknowledges the stop in
 *                            the outbox and releases its locks; a later
 *                            driver ignores the stop. A claim that names no
 *                            generation gets no stop, only the force below.
 *                            After a 30s grace, force only captured process
 *                            identities and witness the tree's exit.
 *                            Foreign PID namespaces,
 *                            unreadable tables and unbindable locks are refused. With
 *                            --expect-started ISO, only the claim acquired
 *                            then is stopped; another holder exits 3.
 *   drives.ts --report [--since <time>] [--json]
 *                            the morning report (`lib/morning-report.ts`).
 *
 * Exit codes:
 *   0  listed / banner printed / positively nothing to report / --doctor's
 *      sweep RAN (whatever verdicts it found — a WEDGED or DEAD_WITH_LEFTOVERS
 *      row is an ordinary finding for a human to read, not a reason to make a
 *      cron job reading this exit code page on it; see `--doctor`'s own
 *      comment in `main`)
 *   1  --stop found nothing live to stop, refused (foreign host, unreadable
 *      claim, unverifiable or non-driver pid), or the driver outlived the
 *      wait; OR the drive's database could not be read
 *   2  usage
 *   3  --stop --expect-started: the lock is held by another acquisition
 */

import {
  processTable,
  type ProcessRow,
} from "../../../shared/process-table.ts";
import {
  captureProcessTree,
  captureRegisteredTreeSnapshot,
  type WindowsTreeState,
  type ProcessTreeControl,
  forceIdentityTargetsAndWitness,
  identityTargetsGone,
} from "../../../shared/process-tree.ts";
import { appendDirective } from "./lib/state/mailbox.ts";
import {
  directiveAcked,
  driverMailboxDir,
  generationAcked,
} from "./lib/state/mailbox-stop.ts";
import * as ledgerStop from "./lib/ledger-stop.ts";
import { existsSync } from "node:fs";
import { driveRepository } from "./lib/drive-repository.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ClaimDiag,
  diagLines,
  ownParentDriver,
  samePidNamespace,
} from "./lib/claim.ts";
import { fail, isDigits, runMain, sleep, testPacing } from "./lib/cli.ts";
import {
  classifyDrive,
  type DoctorInput,
  type DoctorRow,
  formatStopCommand,
  noLiveDriver,
  stallThresholdMs,
} from "./lib/doctor.ts";
import { ciHoldDoctor } from "./lib/ci-hold-doctor.ts";
import {
  findPassChild,
  type PassChildAnswer,
  type ProcRow,
  snapshotProcesses,
} from "./lib/pass-child.ts";
import { git, gitCallTimeoutSeconds, pidAlive } from "./lib/proc.ts";
import { liveDrives, reportMain } from "./lib/morning-report.ts";
import { readStateSnapshot } from "./lib/state/snapshot.ts";
import {
  claimAlive,
  holderGone,
  inspectLock,
  lockLabel,
} from "./lib/driver/locks.ts";

import { READ_ONLY_ENV, dbPathFor, driveDb } from "./lib/state/db.ts";
import { lockRows } from "./lib/state/lock.ts";
import {
  peekResolvedStateDir,
  resolveStateDir,
  stateNumbers,
  worktreeLockName,
} from "./lib/state/store.ts";

const PR_LOCK = /^pr-drive-(\d+)$/;
const WORKTREE_LOCK = /^pr-drive-worktree-([0-9a-f]+)$/;
/**
 * What a real driver's command line looks like in the process table —
 * `drive.ts` as its own path token. Deliberately does NOT match `drives.ts`,
 * so this listing can never mistake itself (or a sibling listing) for a
 * driver.
 *
 * Defence in depth only: argv can prove "a drive.ts process", never "the
 * process that wrote THIS claim" — a pid recycled onto a different live driver
 * passes it. The authoritative identity check is the claim binding in `stop()`:
 * the pid's start time must not postdate the claim's acquisition timestamp.
 */
const DRIVER_CMD = /(^|[\s/\\])drive\.ts(?:["']?)(\s|$)/;

/**
 * Slack for the claim binding's start-time comparison. POSIX creation times
 * have whole-second precision, so the sampled time can differ slightly — without slack
 * a legitimate owner could be refused. A genuinely recycled pid inside
 * this window would additionally have to pass DRIVER_CMD, and the old
 * driver would have to have died within seconds of acquiring.
 */
const START_SLACK_MS = 5_000;

interface LockRow {
  /** Human name: `PR #123` or `worktree ab12…`. */
  lock: string;
  kind: "pr" | "worktree";
  /** The PR number, or the worktree hash. */
  key: string;
  /** The clone's state directory, beside the database the lock is in. */
  stateDir: string;
  /** The lock's name in the drive's database. */
  name: string;
  /** Where the lock is, for a person: its name and the database. */
  dir: string;
  /**
   * `live`/`stale` are the two verdicts a readable single claim gets, by
   * `claimLive`. The rest are the fail-closed shapes: a lock this listing could
   * not positively interpret is REPORTED, never silently dropped — a dropped
   * row reads as "not held", which is the one thing an unreadable lock never
   * established.
   */
  state: "live" | "stale" | "empty" | "contested" | "unreadable";
  pid: number | null;
  host: string | null;
  hostId?: string | undefined;
  platform: string | null;
  nonce: string | null;
  refreshAgeSec: number | null;
  diag: ClaimDiag | null;
  /** The holder's process is confirmed gone by its recorded identity (`holderGone`); absent with no claim. */
  holderGone?: boolean;
  /**
   * This claim's owner is the reader's OWN parent driver — see
   * `ownParentDriver`. Carried on the row rather than derived at each print
   * site so every surface answers the question identically: the text listing's
   * `self:` line, `--json`, and the `--here` banner. It was derived inline at
   * the text site alone, and a pass that censused with `--json` — the natural
   * machine-readable choice — got no self signal at all, stood down against its
   * own parent and burned two no-op rounds (measured; the same shape was
   * already fixed for the label).
   */
  self: boolean;
  /**
   * `lib/doctor.ts`'s classification of this drive — `null` until
   * `attachDoctorVerdicts` populates it, and permanently `null` for a
   * `worktree`-kind row: doctoring is a per-PR question (progress, quota
   * parks and human-parked items are all recorded per PR, never per
   * worktree-lock), so a worktree row has nothing for the classifier to
   * decide. `readLock` never sets this field — only `attachDoctorVerdicts`
   * does, kept as a separate pass so the read-only lock enumeration
   * `listRows` provides to `stop`/`here` never pays for a `ps` call and a
   * per-worktree `git` probe it does not need.
   */
  doctor: DoctorRow | null;
}

function rowName(kind: "pr" | "worktree", key: string): string {
  return kind === "pr" ? `PR #${key}` : `worktree ${key.slice(0, 8)}…`;
}

/** The lock name of a row's kind and key. */
function lockName(kind: "pr" | "worktree", key: string): string {
  return kind === "pr" ? `pr-drive-${key}` : `pr-drive-worktree-${key}`;
}

/** Interpret one driver lock of the clone. A lock nobody holds is `empty`. */
function readLock(
  stateDir: string,
  kind: "pr" | "worktree",
  key: string,
  name = lockName(kind, key),
): LockRow {
  const row: LockRow = {
    lock: rowName(kind, key),
    kind,
    key,
    stateDir,
    name,
    dir: lockLabel({ stateDir, name }),
    state: "empty",
    pid: null,
    host: null,
    platform: null,
    nonce: null,
    refreshAgeSec: null,
    diag: null,
    self: false,
    doctor: null,
  };
  const claim = inspectLock(stateDir, name);
  if (claim === null) return row;
  const ageMs = Date.now() - Date.parse(claim.renewedAt);
  row.pid = claim.pid;
  row.host = claim.host;
  row.hostId = claim.hostId === "" ? undefined : claim.hostId;
  row.platform = claim.platform;
  row.nonce = claim.nonce;
  row.diag = claim.diag;
  row.self = ownParentDriver(claim);
  row.refreshAgeSec = Number.isFinite(ageMs)
    ? Math.max(0, Math.round(ageMs / 1000))
    : null;
  row.state = claimAlive(claim) ? "live" : "stale";
  row.holderGone = holderGone(claim);
  return row;
}

/** Every driver lock of the clone whose state directory is `stateDir`. */
function listRows(stateDir: string): LockRow[] {
  const rows: LockRow[] = [];
  for (const { name } of lockRows(driveDb(stateDir))) {
    const pr = PR_LOCK.exec(name);
    if (pr !== null) {
      rows.push(readLock(stateDir, "pr", pr[1] as string));
      continue;
    }
    const wt = WORKTREE_LOCK.exec(name);
    if (wt !== null) rows.push(readLock(stateDir, "worktree", wt[1] as string));
  }
  rows.sort((a, b) =>
    a.kind === b.kind
      ? a.key.localeCompare(b.key, undefined, { numeric: true })
      : a.kind === "pr"
        ? -1
        : 1,
  );
  return rows;
}

/** Include lock-less states with a quota park, human decisions, a recorded CI hold,
 * or unreadable state. Other historical states carry no active blocker. */
export function listStateOnlyRows(
  stateDir: string,
  lockRows: readonly LockRow[],
): LockRow[] {
  const alreadyLocked = new Set(
    lockRows.filter((r) => r.kind === "pr").map((r) => r.key),
  );
  const rows: LockRow[] = [];
  for (const pr of stateNumbers(stateDir)) {
    if (alreadyLocked.has(pr)) continue;
    const snapshot = readStateSnapshot(stateDir, pr);
    if (
      snapshot.ok &&
      snapshot.state.quotaPark === null &&
      snapshot.state.parked.length === 0 &&
      (snapshot.state.ciHold === null ||
        snapshot.state.ciHold.phase === "released")
    ) {
      continue;
    }
    // `state: 'empty'` — no claim exists to say otherwise, and `'empty'` is
    // already this listing's own vocabulary for "no live driver, lock slot
    // free" (`readLock`'s own default). `diag: null` is not a simplification:
    // there IS no claim here to have carried diagnostics in the first place,
    // so a worktree/log/started for this row would have to be invented.
    rows.push({
      lock: rowName("pr", pr),
      kind: "pr",
      key: pr,
      stateDir,
      name: lockName("pr", pr),
      dir: `the drive state of PR #${pr} in ${dbPathFor(stateDir)}`,
      state: "empty",
      pid: null,
      host: null,
      platform: null,
      nonce: null,
      refreshAgeSec: null,
      diag: null,
      self: false,
      doctor: null,
    });
  }
  return rows;
}

// Absolute, so the copied command resolves from any cwd — a repo-relative hint
// breaks for an operator standing in a subdirectory — and shell-quoted, so it
// survives a repository path containing whitespace. Delegates to
// `lib/doctor.ts`'s `formatStopCommand` so this listing's own stop hint and a
// WEDGED row's `recovery` command are the SAME format, produced by the same
// function, rather than two hand-maintained copies of `bun <self> --stop <pr>`
// that could drift.
const SELF = fileURLToPath(import.meta.url);
const stopHint = (pr: string): string => formatStopCommand(SELF, pr);

// ── Gathering DoctorInput ────────────────────────────────────────────────────
//
// This is the I/O half of `--doctor` — `lib/doctor.ts`'s `classifyDrive` is
// pure and does none of it. Every read below degrades to the `null`/`false`
// that drives `classifyDrive` toward `UNKNOWN` rather than throwing or silently
// treating a failed read as "nothing to report".

export { gatherWorktreeLeftovers } from "./lib/worktree-leftovers.ts";
import { gatherWorktreeLeftovers } from "./lib/worktree-leftovers.ts";

/**
 * Assemble one row's `DoctorInput` — the I/O `classifyDrive` never does.
 *
 * `procs` is the ONE process-table snapshot the whole sweep shares
 * (`snapshotProcesses`), or `null` when that probe could not run — which is
 * `passChild`'s own fail-closed answer, so no separate signalling is needed.
 */
async function gatherDoctorInput(
  stateDir: string,
  row: LockRow,
  selfPath: string,
  procs: readonly ProcRow[] | null,
): Promise<DoctorInput> {
  const snapshot = readStateSnapshot(stateDir, row.key);
  const rawProgressAgeMs =
    snapshot.ok && snapshot.state.lastProgressAt !== ""
      ? Date.now() - Date.parse(snapshot.state.lastProgressAt)
      : null;
  // A FUTURE `lastProgressAt` (clock skew between the machine that stamped it
  // and this one, or a corrupted/hand-edited stored state) makes the subtraction
  // go negative, which reads as "definitely not stale" and — combined with a
  // `passChild` this machine has no way to confirm — reaches `HEALTHY`. `null`
  // is the honest answer: this classifier has no basis for believing progress
  // is fresher than "now" permits, so it is treated exactly like "never
  // recorded" rather than like the freshest possible stamp.
  const progressAgeMs =
    rawProgressAgeMs !== null && rawProgressAgeMs < 0 ? null : rawProgressAgeMs;
  // `''` is a LEGAL `ClaimDiag.worktree` (`claim.ts` only checks `typeof ===
  // 'string'`) — `drive.ts` writes it when `git rev-parse --show-toplevel`
  // itself failed at acquisition time. Read as `null`, not as a worktree path:
  // `''` handed to `git -C '' …` resolves to THIS process's own cwd, not "no
  // worktree", which turned an unrelated dirty operator cwd into a stranger's
  // reported leftovers.
  const worktreePath =
    row.diag?.worktree === undefined || row.diag.worktree === ""
      ? null
      : row.diag.worktree;
  const isLocal = samePidNamespace(row);
  // `passChild` is a pure walk over the shared snapshot — no subprocess of its
  // own, so it costs nothing to compute for every row. Gated on `isLocal`: a
  // foreign-host claim's `pid` is a number in a DIFFERENT machine's process
  // table, and walking it against THIS machine's `procs` snapshot would either
  // find nothing (a false `false`, manufacturing a WEDGED alarm `--stop` cannot
  // act on) or — worse — find a LOCAL process that happens to share the same
  // pid number and has children of its own (a false `true`, reporting a drive
  // that isn't even on this machine as `HEALTHY`).
  const passChild: PassChildAnswer =
    isLocal && procs !== null && row.pid !== null
      ? findPassChild(row.pid, procs)
      : null;
  // The leftovers probe is FOUR `git` subprocesses, and `classifyDrive` reads
  // it on exactly one branch — the one `noLiveDriver` guards. Skipping it
  // elsewhere keeps the cost of the plain listing (which a status board polls)
  // proportional to the drives whose verdict can actually turn on it, rather
  // than to the whole fleet. The predicate is IMPORTED from the classifier
  // rather than restated here, so there is no second copy to drift out of step
  // with its precedence order.
  const leftovers =
    worktreePath !== null && isLocal && noLiveDriver(row.state)
      ? await gatherWorktreeLeftovers(worktreePath, process.cwd())
      : null;
  return {
    lockState: row.state,
    processConfirmedGone: row.holderGone === true,
    progressAgeMs,
    stateReadable: snapshot.ok,
    passChild,
    quotaPark: snapshot.ok ? snapshot.state.quotaPark : null,
    parkedCount: snapshot.ok ? snapshot.state.parked.length : 0,
    parkedQuestions: snapshot.ok
      ? snapshot.state.parked.map((p) => p.reason)
      : [],
    leftovers,
    stallThresholdMs: stallThresholdMs(),
    pr: row.key,
    worktreePath,
    selfPath,
    hostIsLocal: isLocal,
  };
}

/**
 * Populate `.doctor` on every PR-kind row, in place on a COPY of the array
 * (rows themselves are not mutated — callers that already hold a reference to
 * an unenriched row, if any existed, would otherwise see it change under
 * them). `worktree`-kind rows pass through with `doctor` left `null` — see
 * `LockRow.doctor`'s own comment for why doctoring is a per-PR question.
 */
async function attachDoctorVerdicts(
  stateDir: string,
  rows: readonly LockRow[],
  selfPath: string,
  doctorMode: boolean,
): Promise<LockRow[]> {
  // ONE process-table read for the whole sweep, taken before the fan-out
  // rather than once per row — see `snapshotProcesses`' own header for why
  // this is the expensive part and why sharing one instant across rows is
  // the more consistent answer as well as the cheaper one. Skipped entirely
  // when no row could use it, so the common "nothing but empty lock slots"
  // listing spawns no `ps` at all.
  const needsProcs = rows.some((r) => r.kind === "pr" && r.pid !== null);
  const procs = needsProcs ? await snapshotProcesses() : null;
  const diagnosed: LockRow[] = [];
  for (const row of rows) {
    diagnosed.push(
      await (async () => {
        if (row.kind !== "pr") return row;
        const input = await gatherDoctorInput(stateDir, row, selfPath, procs);
        const doctor = classifyDrive(input, new Date());
        const snapshot = readStateSnapshot(stateDir, row.key);
        if (
          doctorMode &&
          snapshot.ok &&
          snapshot.state.ciHold !== null &&
          snapshot.state.ciHold.phase !== "released"
        ) {
          doctor.ciHold = await ciHoldDoctor(
            stateDir,
            row.key,
            snapshot.state,
            row.state,
            fileURLToPath(new URL(".", import.meta.url)),
          );
          doctor.reason += `; ${doctor.ciHold.reason}`;
          if (doctor.ciHold.recovery !== null)
            doctor.recovery = doctor.ciHold.recovery;
        }
        return { ...row, doctor };
      })(),
    );
  }
  return diagnosed;
}

function printHuman(
  stateDir: string,
  rows: LockRow[],
  repository: string,
): void {
  if (rows.length === 0) {
    console.log(`no drive locks under ${stateDir}`);
    return;
  }
  // Group one acquisition's PR and worktree locks by owner and start time.
  const liveByOwner = new Map<string, LockRow[]>();
  const rest: LockRow[] = [];
  for (const row of rows) {
    if (row.state === "live" && row.pid !== null) {
      // A diag-less legacy claim has NO acquisition token, so it may never
      // merge with anything — mapping every missing `started` to one value
      // would group two unrelated legacy claims sharing a recycled pid as
      // one driver. Key it by its own lock
      // instead, so it always lists alone.
      const owner =
        row.diag !== null
          ? `${row.host ?? ""}:${row.platform ?? "legacy"}:${row.pid}:${row.diag.started}`
          : `legacy:${row.host ?? ""}:${row.pid}:${row.kind}:${row.key}`;
      const group = liveByOwner.get(owner) ?? [];
      group.push(row);
      liveByOwner.set(owner, group);
    } else {
      rest.push(row);
    }
  }
  for (const group of liveByOwner.values()) {
    const pid = group[0]?.pid;
    const prRows = group.filter((r) => r.kind === "pr");
    // The lock NAME is authoritative for what this owner drives; the advisory
    // diagnostics may only LABEL, never aim — a corrupt or stale diagnostics
    // line must not point the stop command at a different PR's driver. So the
    // stop hint exists only when EXACTLY ONE live PR lock is in the group — two
    // naming the same owner is lock debris or a corrupt claim, and directory
    // order must not pick which PR the hint targets — and a diagnostics line
    // that disagrees with the held PR lock is called out, not trusted.
    const prRow = prRows.length === 1 ? prRows[0] : undefined;
    const diag = group.find((r) => r.diag !== null)?.diag ?? null;
    const drivenPr = prRow?.key ?? null;
    const claimedPr = diag?.pr ?? null;
    const label =
      prRows.length > 1
        ? `PRs ${prRows.map((r) => `#${r.key}`).join(", ")} — ambiguous`
        : drivenPr !== null
          ? `PR #${drivenPr}`
          : claimedPr !== null
            ? `PR #${claimedPr}? (per diagnostics — no live PR lock held)`
            : "unknown PR";
    const age = group[0]?.refreshAgeSec;
    console.log(
      // Host from the ROW, not parsed out of the grouping key — the key is
      // an internal composite (`legacy:` prefix, acquisition timestamp) and
      // splitting it displayed "legacy" as a hostname.
      `● ${label} — LIVE, driver pid ${pid} (${group[0]?.host || "this host"}), claim refreshed ${age ?? "?"}s ago`,
    );
    console.log(`    repository: ${repository}`);
    if (diag !== null) console.log(diagLines(diag).join("\n"));
    else console.log("    (claim predates diagnostics — pid/host only)");
    console.log(
      `    locks:    ${group.map((r) => (r.kind === "pr" ? `PR #${r.key}` : "worktree")).join(" + ")}`,
    );
    // A heartbeat proves the PROCESS is alive; it says nothing about whether
    // the drive is making PROGRESS — this is that second signal,
    // surfaced on the plain listing (not gated behind `--doctor`) because a
    // LIVE row reading as unremarkable is exactly the false all-clear that
    // let six drives sit live at once with two stale locks nobody had
    // reported. Read off `prRow.doctor` (populated by `attachDoctorVerdicts`
    // before this function is ever called) rather than re-classified here —
    // one classification, one place, same as `--json`'s `doctor` field.
    if (prRow?.doctor?.verdict === "WEDGED") {
      console.log(`    ⚠ stalled: ${prRow.doctor.reason}`);
    }
    // The one reader this line exists for is a PASS: without it the pass
    // applies the second-driver rule to the driver that spawned it and stands
    // down every round while the driver counts each refusal as a completed
    // round (measured: up to ten wasted rounds on one PR). The predicate is
    // `ownParentDriver`, read off the row rather than re-derived here: this
    // line and `--json`'s `self` field answer one question, and the copy that
    // used to live at this site was the only one that existed — leaving
    // `--json` silent.
    if (group[0]?.self === true) {
      console.log(
        `    self:     pid ${pid} is $DRIVE_PR_SESSION — this is YOUR OWN parent driver, and you are the pass it spawned. The second-driver rule does not apply: proceed with the round; do not stand down, do not clear the lease.`,
      );
    }
    const lying = group.find(
      (r) => r.diag !== null && prRow !== undefined && r.diag.pr !== prRow.key,
    )?.diag;
    if (lying !== null && lying !== undefined && prRow !== undefined) {
      console.log(
        `    ⚠ diagnostics claim PR #${lying.pr} — trusting the held PR lock (#${prRow.key})`,
      );
    }
    if (prRows.length > 1) {
      console.log(
        `    ⚠ ${prRows.length} live PR locks name this owner — lock debris or a corrupt claim; no stop hint. Inspect by hand.`,
      );
    }
    if (drivenPr !== null) {
      // Suppressed for one's own parent, exactly as the `--here` banner does:
      // printing a usable `--stop` under a line that just said "proceed, this
      // driver is yours" hands the pass a command that kills the drive it
      // exists to serve. The rest of the group still prints — only the aimed
      // weapon is withheld.
      if (group[0]?.self === true) {
        console.log(
          "    stop:     withheld — this is your own parent driver; stopping it would end the drive you are a round of.",
        );
      } else if (prRow?.diag == null) {
        console.log(
          "    stop:     unavailable — the claim predates diagnostics, so --stop cannot bind the pid to it; inspect by hand.",
        );
      } else {
        console.log(`    stop:     ${stopHint(drivenPr)}`);
      }
    }
  }
  for (const row of rest) {
    if (row.state === "empty") {
      console.log(
        `○ ${row.lock} — empty lock slot (released or mid-transition)`,
      );
    } else if (row.state === "stale") {
      console.log(
        `○ ${row.lock} — stale (owner pid ${row.pid} ${row.pid !== null && pidAlive(row.pid, row.host ?? "") ? "stopped refreshing" : "is gone"}); the next drive recovers it`,
      );
    } else {
      console.log(
        `⚠ ${row.lock} — ${row.state} claim; NOT counting it as free. Inspect by hand: ${row.dir}`,
      );
    }
    console.log(`    repository: ${repository}`);
    // Report stranded work even for stale or empty locks.
    if (row.doctor?.verdict === "DEAD_WITH_LEFTOVERS") {
      console.log(`    ⚠ ${row.doctor.reason}`);
      if (row.doctor.recovery !== null) {
        console.log(`    recovery: ${row.doctor.recovery}`);
      }
    }
  }
}

/** Classify PR lock and state-only rows, including unreadable claims. */
function printDoctor(
  stateDir: string,
  rows: readonly LockRow[],
  repository: string,
): void {
  const prRows = rows.filter((r) => r.kind === "pr");
  if (prRows.length === 0) {
    // Deliberately NOT the plain listing's "no drive locks under X" string —
    // that wording is accurate there (an empty `rows` there really does mean
    // no lock exists), but here `rows` can also be non-empty with only
    // `worktree`-kind entries in it (no `pr`-kind row at all, lock or
    // state-only), which "no drive locks" would misreport as an entirely
    // empty state dir.
    console.log(`no drives to classify under ${stateDir}`);
    return;
  }
  for (const row of prRows) {
    // `attachDoctorVerdicts` populates `.doctor` for every `pr`-kind row
    // unconditionally, so `null` here would mean this row reached printing
    // without going through it — a caller-ordering bug, not a real drive
    // state. Reported rather than silently skipped, per the same fail-closed
    // posture `classifyDrive` itself takes on everything it cannot place.
    const d = row.doctor;
    if (d === null) {
      console.log(`○ PR #${row.key} — UNKNOWN: not classified`);
      console.log(`    repository: ${repository}`);
      continue;
    }
    const icon =
      d.verdict === "HEALTHY" ? "●" : d.verdict === "UNKNOWN" ? "○" : "⚠";
    console.log(`${icon} PR #${row.key} — ${d.verdict}: ${d.reason}`);
    console.log(`    repository: ${repository}`);
    if (d.recovery !== null) console.log(`    recovery: ${d.recovery}`);
  }
}

/**
 * The `--here` banner: is a live driver working THIS worktree? Consumed by
 * the SessionStart hook, so output discipline is the whole contract — see
 * the mode's comment in the header.
 */
async function here(stateDir: string): Promise<number> {
  // Deadlined: under SessionStart a hung git would otherwise run until the
  // outer hook kills the banner, which reads as "checked, and clear" — the one
  // thing a failed check must never look like. On expiry `root.code` is
  // non-zero and the warning path below fires as promised.
  const root = await git(["rev-parse", "--show-toplevel"], {
    stderr: "ignore",
    timeoutSec: gitCallTimeoutSeconds(),
  });
  if (root.code !== 0) {
    console.log(
      "⚠ drive-pr: cannot check this directory for a live drive loop (not a git repository).",
    );
    return 0;
  }
  const row = readLock(stateDir, "worktree", "this", await worktreeLockName());
  if (row.state === "empty" || row.state === "stale") return 0;
  if (row.state !== "live") {
    console.log(
      `⚠ drive-pr: this worktree's drive lock has a ${row.state} claim — could not determine whether a drive loop is working this tree. Inspect: ${row.dir}`,
    );
    return 0;
  }
  // The stop hint must come from an AUTHORITATIVE source — a live per-PR lock
  // whose NAME this same owner holds — never from the advisory diagnostics
  // alone: a stale or corrupt diagnostics line would otherwise aim --stop at a
  // different PR's driver. Best-effort: a correlation that cannot be read
  // degrades to the unverified wording, never to a loud failure — this is still
  // the banner. And it must be UNIQUE: two live PR locks naming this same owner
  // is lock debris or a corrupt claim, and directory order must not pick which
  // PR the stop command targets — several matches degrade to the ambiguous
  // wording, with no stop hint.
  let verifiedPr: string | null = null;
  let ambiguousPrs: string[] = [];
  try {
    // host/pid alone can collide ACROSS acquisitions: a driver killed
    // between its two lock writes leaves a live worktree claim whose pid,
    // recycled onto a different driver, would correlate with that driver's
    // PR lock. One acquisition
    // writes ONE diag object to both locks, so `diag.started` is a free
    // instance token — require it to match, and degrade legacy diag-less
    // claims to the unverified wording rather than correlating them.
    const owned = listRows(stateDir).filter(
      (r) =>
        r.kind === "pr" &&
        r.state === "live" &&
        r.pid === row.pid &&
        (r.host ?? "") === (row.host ?? "") &&
        r.platform === row.platform &&
        r.diag !== null &&
        row.diag !== null &&
        r.diag.started === row.diag.started,
    );
    if (owned.length === 1) verifiedPr = (owned[0] as LockRow).key;
    else ambiguousPrs = owned.map((r) => r.key);
  } catch {
    verifiedPr = null;
  }
  const driving =
    verifiedPr !== null
      ? `driving PR #${verifiedPr}`
      : ambiguousPrs.length > 1
        ? `named by ${ambiguousPrs.length} live PR locks (${ambiguousPrs.map((k) => `#${k}`).join(", ")}) — ambiguous; inspect by hand`
        : row.diag !== null
          ? `claiming PR #${row.diag.pr} in its diagnostics (no matching live PR lock found)`
          : "driving an unknown PR (claim predates diagnostics)";
  // A PASS's own SessionStart hook runs this banner, and the holder it finds is
  // its own parent driver — so the unqualified warning below is the first thing
  // that tells a pass to treat its driver as a rival, before it censuses
  // anything (measured: two no-op rounds, the shape reaching the pass through a
  // surface the label never covered). Say so instead, and stop: every line
  // after this one — "interactive edits here will race it", the stop command —
  // is advice for a bystander, and is exactly wrong for the pass this tree is
  // being driven FOR.
  if (row.self) {
    console.log(
      `drive-pr: the live drive loop working THIS worktree is pid ${row.pid} — $DRIVE_PR_SESSION, i.e. YOUR OWN parent driver, ${driving}. You are the pass it spawned: proceed with the round. Do not stand down, do not stop it, do not clear its lease.`,
    );
    if (row.diag !== null) console.log(`  Log: ${row.diag.log}`);
    return 0;
  }
  console.log(
    `⚠ drive-pr: a LIVE drive loop is working THIS worktree — pid ${row.pid}, ${driving}${row.diag !== null ? `, since ${row.diag.started}` : ""}.`,
  );
  if (verifiedPr !== null && row.diag !== null && row.diag.pr !== verifiedPr) {
    console.log(
      `  ⚠ its diagnostics claim PR #${row.diag.pr} — trusting the held PR lock (#${verifiedPr})`,
    );
  }
  console.log(
    "  It edits, commits and pushes this tree between rounds; interactive edits here will race it.",
  );
  if (row.diag !== null) console.log(`  Log: ${row.diag.log}`);
  // Never recommend a raw `kill <pid>` here: the claim proves liveness, not
  // identity — --stop's process-table check exists precisely because a recycled
  // pid can wear a fresh claim, and a banner bypassing that check would aim the
  // operator at a possibly unrelated process.
  console.log(
    verifiedPr !== null
      ? `  Stop it: ${stopHint(verifiedPr)}   (or leave the tree to it until it converges)`
      : `  No live PR lock verifies this driver, so there is no safe stop command — inspect the claim first: ${row.dir}   (or leave the tree to it until it converges)`,
  );
  return 0;
}

async function stop(
  stateDir: string,
  pr: string,
  expectStarted: string,
  reason: string,
): Promise<number> {
  const row = readLock(stateDir, "pr", pr);
  if (row.state === "empty" || row.state === "stale") {
    console.log(
      row.state === "empty"
        ? `no drive holds PR #${pr}'s lock — nothing to stop.`
        : `PR #${pr}'s lock is stale (owner pid ${row.pid} no longer counts as live) — nothing to stop; the next drive recovers it.`,
    );
    await ledgerStop.recoverIdleStop(stateDir, pr, row);
    return 1;
  }
  if (row.state !== "live") {
    console.log(
      `PR #${pr}'s lock has a ${row.state} claim — refusing to guess who to signal. Inspect: ${row.dir}`,
    );
    return 1;
  }
  // The row read here is the one every check below verifies and the stop
  // request addresses (by its nonce), so the expected acquisition binds them.
  if (expectStarted !== "" && row.diag?.started !== expectStarted) {
    console.log(
      `PR #${pr}'s lock is held by another acquisition (started ${row.diag?.started ?? "unrecorded"}, expected ${expectStarted}) — not stopping it.`,
    );
    return 3;
  }
  const pid = row.pid as number;
  if (!samePidNamespace(row)) {
    console.log(
      `PR #${pr}'s driver runs on ${row.host} (${row.platform ?? "unknown platform"}) — stop it from that PID namespace (pid ${pid}).`,
    );
    return 1;
  }
  const v = await verifyDriverClaim(row, pid);
  const code =
    "code" in v ? v.code : await stopVerifiedDriver(row, v.owner, reason);
  // Witnessed gone, or already gone with nothing witnessing its pass.
  if (code === 0)
    await ledgerStop.settleStop(stateDir, pr, row, !("code" in v));
  return code;
}

async function verifyDriverClaim(
  row: LockRow,
  pid: number,
): Promise<{ code: number } | { owner: ProcessRow }> {
  const snapshot = await processTable(
    testPacing("DRIVE_PR_STOP_PS_TIMEOUT_SEC", 10, 1),
  );
  const owner = snapshot?.find((p) => p.pid === pid);
  const cmd = owner?.args ?? "";
  if (owner === undefined || cmd === "") {
    if (snapshot !== null && owner === undefined) {
      console.log(`driver pid ${pid} was already gone.`);
      return { code: 0 };
    }
    console.log(
      `refusing to signal pid ${pid}: could not verify its command via process table, and a fresh claim proves liveness, not identity — the pid may have been recycled.`,
    );
    console.log(`Inspect the claim by hand before acting: ${row.dir}`);
    return { code: 1 };
  }
  if (!DRIVER_CMD.test(cmd)) {
    console.log(
      `refusing to signal pid ${pid}: its command does not look like a drive.ts driver —`,
    );
    console.log(`  ${cmd}`);
    console.log(
      "The pid was likely recycled after a crash; the claim is effectively stale, and the next drive recovers the lock.",
    );
    return { code: 1 };
  }
  if (row.diag === null) {
    console.log(
      `refusing to signal pid ${pid}: the claim carries no diagnostics line, so nothing binds this pid to this claim — a recycled pid running another driver would be indistinguishable from the owner.`,
    );
    console.log(`Inspect the claim by hand before acting: ${row.dir}`);
    return { code: 1 };
  }
  const claimStartedMs = Date.parse(row.diag.started);
  const processStartedMs = Date.parse(owner?.start ?? "");
  if (Number.isNaN(claimStartedMs) || Number.isNaN(processStartedMs)) {
    console.log(
      `refusing to signal pid ${pid}: could not compare its start time (${JSON.stringify(owner?.start)}) to the claim's acquisition time (${JSON.stringify(row.diag.started)}).`,
    );
    console.log(`Inspect the claim by hand before acting: ${row.dir}`);
    return { code: 1 };
  }
  // A FUTURE acquisition time defeats the whole binding: `procStart > future +
  // slack` is false for every process, so a recycled pid wearing a clock-skewed
  // or corrupt claim would pass. A claim can never be legitimately acquired
  // after "now", so materially-future is refused, not compared.
  if (claimStartedMs > Date.now() + START_SLACK_MS) {
    console.log(
      `refusing to signal pid ${pid}: the claim's acquisition time (${row.diag.started}) is in the future — clock skew or a corrupt claim, and a future bound accepts every process.`,
    );
    console.log(`Inspect the claim by hand before acting: ${row.dir}`);
    return { code: 1 };
  }
  if (processStartedMs > claimStartedMs + START_SLACK_MS) {
    console.log(
      `refusing to signal pid ${pid}: it started after the claim that names it was written, so it is not the claim's writer — the pid was recycled (its command happens to be a driver: ${cmd}).`,
    );
    console.log(
      "The claim is effectively stale; the next drive recovers the lock.",
    );
    return { code: 1 };
  }
  return { owner };
}

/** Where a stop sent to a driver lands, and its directive's id once sent. */
interface SentStop {
  dir: string;
  pr: string;
  id: string | null;
}

/**
 * Send the driver a mailbox `stop` addressed to its generation, marked `now`.
 * `false` when it could not be written; a claim naming no generation (an
 * earlier release's driver) or no working tree is sent nothing and left to
 * the grace and force.
 */
async function requestVerifiedDriverStop(
  row: LockRow,
  owner: ProcessRow,
  sent: SentStop,
): Promise<boolean> {
  const pid = owner.pid;
  const generation = row.diag?.generation;
  if (generation === undefined || sent.dir === "") {
    console.log(
      `driver pid ${pid}'s claim names no ${generation === undefined ? "driver generation" : "working tree"}, so no stop can be addressed to it; forcing its captured process identities after the grace.`,
    );
    return true;
  }
  try {
    const directive = await appendDirective(
      sent.dir,
      sent.pr,
      "drives.ts --stop",
      "stop",
      { generation, now: true },
    );
    sent.id = directive.id;
  } catch (error) {
    console.log(`cannot request stop of driver pid ${pid}: ${String(error)}`);
    return false;
  }
  console.log(
    `requested stop of driver pid ${pid} (generation ${generation}, directive ${sent.id}) — it stops its pass tree, then releases its locks…`,
  );
  return true;
}

async function stopVerifiedDriver(
  row: LockRow,
  owner: ProcessRow,
  reason: string,
): Promise<number> {
  const pid = owner.pid;
  const refusal = await prepareOperatorStop(row, pid, reason);
  if (refusal !== null) return refusal;
  // Capture descendants before requesting shutdown: the root may leave before
  // its descendants, and the fallback must never rediscover a recycled PID.
  const targets = await captureProcessTree(pid);
  if (
    targets === null ||
    !targets.some((p) => p.pid === pid && p.start === owner?.start)
  ) {
    console.log(
      `refusing to stop pid ${pid}: its identity changed or its process tree could not be verified.`,
    );
    return 1;
  }
  const registry =
    process.platform === "win32" && row.nonce !== null
      ? join(row.stateDir, `${row.name}.processes.${row.nonce}`)
      : null;
  const registryState: WindowsTreeState = { root: owner, targets };
  const sent: SentStop = {
    dir: driverMailboxDir(row.diag?.worktree ?? "", row.diag?.mailbox ?? ""),
    pr: row.diag?.pr ?? "",
    id: null,
  };
  const generation = row.diag?.generation;
  const completed = () =>
    sent.id !== null &&
    (directiveAcked(sent.dir, sent.pr, sent.id) ||
      (generation !== undefined &&
        generationAcked(sent.dir, sent.pr, generation)));
  const refreshRegistered = registryCompletionTracker(
    registry,
    registryState,
    completed,
  );
  if (!(await refreshRegistered())) {
    console.log(
      `driver pid ${pid}'s registry is incomplete; requesting cleanup while retaining its known process identities.`,
    );
  }
  if (!(await requestVerifiedDriverStop(row, owner, sent))) return 1;
  const graceSec = testPacing("DRIVE_PR_STOP_GRACE_SEC", 30, 1);
  const deadline = Date.now() + graceSec * 1000;
  while (Date.now() < deadline) {
    if (!(await refreshRegistered())) {
      await sleep(0.25);
      continue;
    }
    if (await identityTargetsGone(targets)) {
      console.log(
        `stopped: driver pid ${pid} and its captured pass tree exited.`,
      );
      return 0;
    }
    await sleep(0.25);
  }
  return forceStopDriver(
    owner,
    targets,
    refreshRegistered,
    graceSec,
    registryState,
    completed,
  );
}

/** Directory removal cannot turn an unreadable registration into completed work. */
export function registryCompletionTracker(
  registry: string | null,
  state: WindowsTreeState,
  completed: () => boolean = () => false,
): (control?: ProcessTreeControl) => Promise<boolean> {
  let complete = false;
  return async (control = {}) => {
    if (completed() || registry === null) return true;
    if (!existsSync(registry)) return complete;
    complete = (
      await captureRegisteredTreeSnapshot(registry, { ...control, state })
    ).complete;
    return complete;
  };
}

async function forceKnownStopTargets(
  owner: ProcessRow,
  targets: ProcessRow[],
  refreshRegistered: (control?: ProcessTreeControl) => Promise<boolean>,
  state: WindowsTreeState,
  completed: () => boolean,
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  const control: ProcessTreeControl = {
    deadline,
    state,
    onKilled: (target) => {
      state.forcedIdentities ??= new Set();
      state.forcedIdentities.add(`${target.pid}:${target.start}`);
    },
  };
  const refreshOwner = () =>
    captureRegisteredTreeSnapshot("", {
      ...control,
      registrySnapshot: () => ({ roots: [owner], complete: true }),
    });
  while (Date.now() < deadline) {
    await refreshOwner();
    await refreshRegistered(control);
    const count = targets.length;
    const gone = await forceIdentityTargetsAndWitness(targets, control);
    const root = await refreshOwner();
    const complete = await refreshRegistered(control);
    if (targets.length !== count) continue;
    return gone && ((root.complete && complete) || completed());
  }
  return false;
}

/** Force known identities even when a pending registration withholds completion. */
export async function forceStopDriver(
  owner: ProcessRow,
  targets: ProcessRow[],
  refreshRegistered: (control?: ProcessTreeControl) => Promise<boolean>,
  graceSec: number,
  registryState: WindowsTreeState = { root: owner, targets },
  completed: () => boolean = () => false,
): Promise<number> {
  console.log(
    `driver pid ${owner.pid} outlived the ${graceSec}s grace — forcing its captured process identities to exit.`,
  );
  const confirmed = await forceKnownStopTargets(
    owner,
    targets,
    refreshRegistered,
    registryState,
    completed,
  );
  if (!confirmed) {
    console.log(
      `known identities for driver pid ${owner.pid} were forced, but a complete stop could not be witnessed; inspect before restarting.`,
    );
    return 1;
  }
  console.log(
    `stopped: driver pid ${owner.pid} and its captured pass tree exited; abandoned locks are recovered by the next drive.`,
  );
  return 0;
}

/** `--report` is a mode of its own; every other mode is the fleet's. */
async function entry(): Promise<number> {
  const argv = process.argv.slice(2);
  return argv.includes("--report")
    ? reportMain(argv, async (stateDir) => liveDrives(listRows(stateDir)))
    : main(argv);
}

async function main(argv: string[]): Promise<number> {
  let json = false;
  let hereMode = false;
  let stopPr = "";
  let doctorMode = false;
  let onlyPr = "";
  const expectStarted = takeExpectStarted(argv);
  const reason = takeReason(argv);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") json = true;
    else if (a === "--here") hereMode = true;
    else if (a === "--doctor") doctorMode = true;
    else if (a === "--pr") {
      onlyPr = argv[++i] ?? "";
      if (!isDigits(onlyPr)) fail(2, "--pr takes a PR number");
    } else if (a === "--stop") {
      stopPr = argv[i + 1] ?? "";
      i++;
      if (!isDigits(stopPr)) fail(2, "--stop takes a PR number");
    } else {
      fail(
        2,
        `usage: drives.ts [--json] | [--here] | [--stop <PR> [--expect-started <ISO>]] | [--doctor [--json]] | [--report [--since <time>] [--json]]\n--doctor writes stopped ledgers for confirmed-dead local acquisitions with a released witness or complete pass observations, then releases its recovery leases.`,
      );
    }
  }
  if (onlyPr !== "" && !doctorMode) fail(2, "--pr requires --doctor");
  requireStopOptions(expectStarted, reason, stopPr);
  // `--doctor` combines with `--json` but is otherwise mutually
  // exclusive with every other mode, on the same terms `--here`/`--json`/
  // `--stop` already are with each other.
  if (
    (hereMode && (json || stopPr !== "" || doctorMode)) ||
    (json && stopPr !== "") ||
    (doctorMode && stopPr !== "")
  ) {
    fail(
      2,
      "--json, --here, --stop and --doctor are mutually exclusive (--doctor may combine with --json)",
    );
  }

  // In --here mode the state-dir resolution itself is inside the banner's
  // silence contract: a failure reports on stderr and throws, the
  // SessionStart hook discards stderr, and a thrown exit would otherwise
  // read as "checked, and clear" — the one thing a failed check must never
  // look like. Every other mode keeps the loud failure.
  //
  // `peekResolvedStateDir()`, never the mutating `resolveStateDir()`: this
  // runs on every session's own SessionStart hook, and merely opening an
  // otherwise-unused repository must not mint a clone identity to answer a
  // read-only banner check. A clone with no identity has no drive.
  if (hereMode) {
    let stateDir: string | null;
    try {
      stateDir = await peekResolvedStateDir();
    } catch {
      console.log(
        "⚠ drive-pr: cannot check this directory for a live drive loop (no resolvable state dir — not a git repository?).",
      );
      return 0;
    }
    return stateDir === null ? 0 : here(stateDir);
  }
  if (stopPr !== "")
    return stop(await resolveStateDir(), stopPr, expectStarted, reason);

  // Read-only listing, same reasoning as --here above: this must not mint a
  // clone identity merely to enumerate it.
  const stateDir = await peekResolvedStateDir();
  if (stateDir === null) {
    if (json)
      console.log(JSON.stringify({ stateDir: null, rows: [] }, null, 2));
    else console.log("no drive locks: this clone has never been driven");
    return 0;
  }
  const lockRows = listRows(stateDir);
  // `--doctor`'s population is locks ∪ states; the plain listing and
  // plain `--json` stay lock rows only (`listStateOnlyRows` says why).
  const rows = doctorMode
    ? await doctorRows(stateDir, lockRows, onlyPr)
    : lockRows;
  // Classified in every mode: `--json` always carries the verdict, and the
  // human listing's "stalled" annotation reads the same `.doctor` field.
  const repository = await driveRepository();
  const doctored = (
    await attachDoctorVerdicts(
      stateDir,
      onlyPr === ""
        ? rows
        : rows.filter((row) => row.kind === "pr" && row.key === onlyPr),
      SELF,
      doctorMode,
    )
  ).map((row) => ({ ...row, repository }));
  if (json) console.log(JSON.stringify({ stateDir, rows: doctored }, null, 2));
  else if (doctorMode) printDoctor(stateDir, doctored, repository);
  else printHuman(stateDir, doctored, repository);
  return 0;
}

/** `--doctor`'s population, recovered first (a takeover reads `--json`). */
async function doctorRows(
  stateDir: string,
  lockRows: LockRow[],
  onlyPr: string,
) {
  if (process.env[READ_ONLY_ENV] !== "1") {
    await ledgerStop.recoverStoppedLedgers(stateDir, (pr) => {
      if (onlyPr !== "" && pr !== onlyPr) return true;
      const snapshot = readStateSnapshot(stateDir, pr);
      return (
        snapshot.ok &&
        snapshot.state.ciHold !== null &&
        snapshot.state.ciHold.phase !== "released"
      );
    });
  }
  return [...lockRows, ...listStateOnlyRows(stateDir, lockRows)];
}

// Gated, so a helper such as `gatherWorktreeLeftovers` can be imported
// without running this CLI against the importer's `process.argv`.
if (import.meta.main) runMain("drives.ts", entry);
