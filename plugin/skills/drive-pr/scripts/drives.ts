#!/usr/bin/env bun
/**
 * drives.ts — the operator's answer to "who is driving what, from where?"
 *
 * A drive is routinely armed as a background child of a session that ends
 * long before the drive does (do-item's "Arm the drive" step), so the
 * running fleet is invisible by default: the locks name a pid, the pid has no
 * pane, and the refusal a second start meets ("another driver already holds
 * the … lock") names a process the operator has no window into. This command
 * is that window. Scope is ONE clone's state universe — the same
 * `resolveStateDir` every driver shares (keyed per clone), so
 * every Conductor worktree of a clone sees the same fleet; a different clone
 * has a fleet of its own.
 *
 * READ-ONLY over lock state, by design: a stale lock is the next `acquire`'s
 * to recover, a contested one is a human's, and a listing that also swept
 * would be a second writer to a protocol built around exactly one
 * (`drive.ts` § Single-instance locking). Claims are interpreted by exactly
 * the rule recovery uses — `lib/claim.ts`, shared with the writer — so this
 * listing can never call a claim live that recovery would retire, or vice
 * versa. `--stop` writes a stop request beside the claim; it never removes the claim.
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
 *                            listing: lock directories only, which is what a
 *                            status board polling this mode consumes.
 *   drives.ts --doctor       one classified verdict per drive in the state
 *                            universe — HEALTHY, WEDGED,
 *                            DEAD_WITH_LEFTOVERS, QUOTA_PARKED, NEEDS_HUMAN
 *                            or UNKNOWN, plus a recovery command where one
 *                            exists. See `lib/doctor.ts` for the classifier
 *                            and its precedence order.
 *
 *                            A WIDER POPULATION than the two modes above,
 *                            and that difference is the point: `drive.ts`
 *                            `rmdir`s its lock slot on every normal exit,
 *                            INCLUDING both quota-park exits and the HITL
 *                            park, so a parked drive has no lock directory
 *                            left while its `drive-pr-<N>.json` — carrying
 *                            the `quotaPark` and `parked` this sweep exists
 *                            to report — survives. This mode's population is
 *                            therefore lock dirs UNION state files; a
 *                            state-file-only drive appears as a `state:
 *                            'empty'` row with no `diag`. Combines with
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
 *                            then write a generation-addressed stop request.
 *                            The driver stops its pass tree and releases its
 *                            locks. After a 30s grace, force only captured
 *                            process identities and witness the tree's exit.
 *                            Older POSIX drivers receive SIGTERM instead.
 *                            Foreign PID namespaces, unreadable tables and
 *                            unbindable claims are refused.

 *
 * Exit codes:
 *   0  listed / banner printed / positively nothing to report / --doctor's
 *      sweep RAN (whatever verdicts it found — a WEDGED or DEAD_WITH_LEFTOVERS
 *      row is an ordinary finding for a human to read, not a reason to make a
 *      cron job reading this exit code page on it; see `--doctor`'s own
 *      comment in `main`)
 *   1  --stop found nothing live to stop, refused (foreign host, unreadable
 *      claim, unverifiable or non-driver pid), or the driver outlived the
 *      wait; OR --doctor's sweep could not even ENUMERATE the state universe
 *      (the state dir itself could not be read — the same failure `listRows`
 *      already treats as fatal for the plain listing)
 *   2  usage
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
  signalIdentityTargets,
  identityTargetsGone,
} from "../../../shared/process-tree.ts";
import { requestDriverStop } from "./lib/stop-request.ts";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAIM_PREFIX,
  type ClaimDiag,
  claimLive,
  samePidNamespace,
  parseClaimText,
} from "./lib/claim.ts";
import { fail, isDigits, runMain, sleep, testPacing } from "./lib/cli.ts";
import {
  classifyDrive,
  type DoctorInput,
  type DoctorLeftovers,
  type DoctorRow,
  formatStopCommand,
  noLiveDriver,
  stallThresholdMs,
} from "./lib/doctor.ts";
import { formatAccountIdentity } from "./lib/identity.ts";
import {
  findPassChild,
  type PassChildAnswer,
  type ProcRow,
  snapshotProcesses,
} from "./lib/pass-child.ts";
import {
  git,
  gitCallTimeoutSeconds,
  gitIdentityEnv,
  pidAlive,
  unconcludedGitOpMarker,
} from "./lib/proc.ts";
import { legacyFootprint } from "./lib/state/legacy-state.ts";
import { type DriveState, isUsableState } from "./lib/state/schema.ts";
import {
  peekResolvedStateDir,
  resolveLegacyStateDir,
  resolveStateDir,
  worktreeLockName,
} from "./lib/state/store.ts";

const PR_LOCK = /^pr-drive-(\d+)\.lock$/;
const WORKTREE_LOCK = /^pr-drive-worktree-([0-9a-f]+)\.lock$/;
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
const DRIVER_CMD = /(^|[\s/\\])drive\.ts(?:["\']?)(\s|$)/;

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
  platform: string | null;
  nonce: string | null;
  refreshAgeSec: number | null;
  diag: ClaimDiag | null;
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

/**
 * Is this claim's owner the driver that spawned ME? `drive.ts` exports
 * $DRIVE_PR_SESSION as its own pid before spawning each round's agent, so a
 * pass finding a live holder with that exact pid is looking at its own parent,
 * never a competing driver — and the second-driver rule (SKILL.md § 6) does not
 * apply to it.
 *
 * Pid equality is only meaningful on the host that wrote the claim, so a
 * differing or absent host answers false — failing toward the safe reading
 * (a foreign driver), never toward "proceed". An unset $DRIVE_PR_SESSION means
 * the reader is not a pass at all, which answers false for the same reason.
 *
 * A pid is REUSED, though, and that is the gap this function closes second: a
 * dead driver's still-fresh claim whose pid the OS handed to this pass's own
 * parent reads live to `claimLive` and matches $DRIVE_PR_SESSION, so pid+host
 * alone would grant `self` over a lock the parent never took. `drive.ts`
 * therefore exports its claim's own acquisition token as
 * $DRIVE_PR_SESSION_STARTED, and when the claim carries a `started` of its own
 * the two must be EQUAL — the same instance-token correlation this file already
 * uses to tie a worktree lock to a PR lock.
 *
 * The token is required whenever THIS process's environment supplies one — not
 * only when the on-disk claim also happens to carry one. `drive.ts` always
 * exports both together, so a pass holding $DRIVE_PR_SESSION_STARTED is
 * necessarily a pass whose own parent writes diagnostics into every claim it
 * takes; a live claim matching pid+host but carrying no `started` at all is
 * therefore proven to be a DIFFERENT process's claim — the exact pid-recycling
 * case this token exists to catch — and must answer false, not fall back to the
 * legacy heuristic (the prior `token !== '' && diag !== null` guard let a
 * diagnostics-free claim ride pid+host to `self` even with a token present).
 * Only a harness opting in by hand (`DRIVE_PR_SESSION=<agent pid>`, SKILL.md §
 * 6), which exports no token at all, still falls back to pid+host — demanding a
 * token there would answer false for every pass under that configuration, which
 * is the stand-down bug this whole mechanism exists to prevent, in the one
 * direction that is silent.
 *
 * That fallback is narrower than "no token on our side", though: it is
 * sanctioned ONLY for the genuine older legacy case, which by construction
 * writes a diagnostics-free claim of its own — so the fallback must
 * additionally require `diag === null`. A claim that DOES carry diagnostics can
 * never be that harness's own write (only `drive.ts`'s `acquire` stamps
 * diagnostics, and it always exports the token alongside them), so a
 * diagnostics-bearing claim matching pid+host while OUR OWN env carries no
 * token is proof of an unrelated process — most plausibly a modern,
 * still-diagnosed claim from a dead driver whose pid got recycled — and must
 * answer false rather than silently trusting pid+host over evidence that
 * contradicts it.
 */
function ownParentDriver(
  pid: number | null,
  host: string | null,
  diag: ClaimDiag | null,
): boolean {
  const session = process.env.DRIVE_PR_SESSION ?? "";
  if (
    pid === null ||
    session === "" ||
    String(pid) !== session ||
    host === null ||
    host !== hostname()
  ) {
    return false;
  }
  const token = process.env.DRIVE_PR_SESSION_STARTED ?? "";
  if (token !== "") return diag !== null && diag.started === token;
  return diag === null;
}

function rowName(kind: "pr" | "worktree", key: string): string {
  return kind === "pr" ? `PR #${key}` : `worktree ${key.slice(0, 8)}…`;
}

/** Interpret one lock directory. Never throws; failures become row states. */
function readLock(dir: string, kind: "pr" | "worktree", key: string): LockRow {
  const row: LockRow = {
    lock: rowName(kind, key),
    kind,
    key,
    dir,
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
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (e) {
    // Vanished between the state-dir listing and here = released mid-listing:
    // positively free. Anything else is a lock that exists but cannot be
    // read, which must not read as free.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return row;
    row.state = "unreadable";
    return row;
  }
  const claims = names.filter(
    (n) => n.startsWith(CLAIM_PREFIX) && n.length > CLAIM_PREFIX.length,
  );
  if (claims.length === 0) return row; // empty: retired/released, not yet reused
  if (claims.length > 1) {
    row.state = "contested";
    return row;
  }
  const claimPath = join(dir, claims[0] as string);
  let record: ReturnType<typeof parseClaimText>;
  let ageMs: number | null;
  try {
    record = parseClaimText(readFileSync(claimPath, "utf8"));
    ageMs = Date.now() - statSync(claimPath).mtimeMs;
  } catch {
    row.state = "unreadable";
    return row;
  }
  if (record === null) {
    row.state = "unreadable";
    return row;
  }
  row.pid = record.pid;
  row.host = record.host;
  row.platform = record.platform;
  row.nonce = (claims[0] as string).slice(CLAIM_PREFIX.length);
  row.diag = record.diag;
  row.self =
    samePidNamespace(record) &&
    ownParentDriver(record.pid, record.host, record.diag);
  row.refreshAgeSec = Math.max(0, Math.round(ageMs / 1000));
  row.state = claimLive({ ...record, ageMs }) ? "live" : "stale";
  return row;
}

function listRows(stateDir: string): LockRow[] {
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    // A state dir that cannot be read has verified nothing — say so rather than
    // return an empty fleet.
    fail(1, `drives.ts: cannot read the state dir ${stateDir}`);
  }
  const rows: LockRow[] = [];
  for (const entry of entries) {
    const pr = PR_LOCK.exec(entry);
    if (pr !== null) {
      rows.push(readLock(join(stateDir, entry), "pr", pr[1] as string));
      continue;
    }
    const wt = WORKTREE_LOCK.exec(entry);
    if (wt !== null) {
      rows.push(readLock(join(stateDir, entry), "worktree", wt[1] as string));
    }
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

const STATE_FILE = /^drive-pr-(\d+)\.json$/;

/**
 * `--doctor`-ONLY extension of the sweep population beyond `listRows`'s lock
 * census.
 *
 * `drive.ts` `rmdir`s its lock slot on EVERY normal process exit
 * (`release`, run from `releaseAll` on `process.on('exit')`) — including
 * both the quota-park exit (`QUOTA_PARKED_EXIT`) and the HITL-park exit,
 * neither of which is a crash. A drive that parked (for a quota wall or for
 * a human) and then exited normally therefore has NO lock directory left at
 * all, while its `drive-pr-<PR>.json` — carrying the exact
 * `quotaPark`/`parked` record `--doctor` exists to surface — survives
 * untouched. A sweep that reads only lock directories reports "no drive
 * locks" for precisely the two verdicts (`QUOTA_PARKED` after the exiting
 * park, `NEEDS_HUMAN` once every remaining item is parked) this feature was
 * built to answer.
 *
 * Deliberately scoped to `--doctor` (and `--doctor --json`) only, NOT the plain
 * listing or plain `--json` — a considered choice, not an oversight: the plain
 * listing's own stated purpose is "list every drive LOCK" (see the module
 * header), and a state-file-only row has no lock to report — showing one there
 * would be new information arriving through a surface that never promised to
 * carry it, and a status board polling plain `--json` has no use for a row it
 * would immediately filter out (it only reads `state === 'live'`). `--doctor`
 * is a state-derived health judgment, so it is the one surface whose whole job
 * is exactly this kind of row.
 *
 * Returns ONLY the rows `listRows` did not already report — a PR with a live
 * (or stale, or contested…) lock is represented by `listRows`'s own row, not
 * a duplicate here, however this function's population is computed — and,
 * among those, only the ones with something to say: a state file that reads
 * cleanly and carries neither a park nor a parked item is skipped, while an
 * UNREADABLE one is always reported. See the inline comment on that guard for
 * the measurement that forced it and why it is not a fail-open.
 *
 * Exported for `drives.test.ts` — its own fail-closed-on-read-failure
 * behavior is unit-tested directly, the same way `gatherWorktreeLeftovers`
 * is.
 */
export function listStateOnlyRows(
  stateDir: string,
  lockRows: readonly LockRow[],
): LockRow[] {
  const alreadyLocked = new Set(
    lockRows.filter((r) => r.kind === "pr").map((r) => r.key),
  );
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch (e) {
    // `listRows` above already read (or fatally failed on) this exact directory
    // moments ago, so ENOENT here means it vanished in the narrow TOCTOU window
    // between that read and this one — positively benign, matching `readLock`'s
    // own ENOENT-is-not-an-error stance, and "no extra rows" is the correct
    // answer for a directory that is genuinely gone. Anything else (a transient
    // permission, descriptor, or I/O error) is NOT that case, and treating it
    // identically would silently convert a read failure into an empty
    // population — hiding exactly the quota-parked and human-parked drives
    // whose normal exit already removed their lock directories, which is the
    // entire reason this second census exists (fail closed on input the gate
    // cannot read).
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    fail(
      1,
      `drives.ts: cannot read the state dir ${stateDir} for --doctor's state-only census`,
    );
  }
  const rows: LockRow[] = [];
  for (const entry of entries) {
    const m = STATE_FILE.exec(entry);
    if (m === null) continue;
    const pr = m[1] as string;
    if (alreadyLocked.has(pr)) continue;
    // A lock-less state file earns a row only when it has something to SAY.
    //
    // Measured before this guard existed: one ordinary clone's state dir held
    // 237 `drive-pr-*.json` files, so `--doctor` printed 238 rows — every one
    // of them `UNKNOWN`. A sweep whose first run buries its findings under
    // two hundred lines of "insufficient evidence" is a sweep nobody reads,
    // which defeats the whole feature. The files accumulate per PR ever
    // driven in the clone and are bounded only by `reap-state.ts`'s weekly
    // lifecycle pass, so this is a STEADY-STATE property, not a one-off from
    // the older files that happen to dominate the count today.
    //
    // The filter is not a fail-open. Failing closed is about input the gate
    // CANNOT READ, and an UNREADABLE state file is still reported — that is the
    // `!snapshot.ok` arm below, and it is exactly the "your state dir is full
    // of files this version refuses" signal an operator needs. What is dropped
    // is the opposite case: a file read SUCCESSFULLY, which positively says
    // there is no park and nothing parked. Those are the only two verdicts a
    // lock-less row can ever carry — `DEAD_WITH_LEFTOVERS` needs a worktree
    // path, and a row with no claim has no `diag` to supply one — so a
    // readable, park-free, nothing-parked state file has no reachable finding
    // to hide. Reporting it as `UNKNOWN` would not be caution; it would be
    // noise asserted with the same word this classifier uses for genuine
    // uncertainty.
    const snapshot = readStateSnapshot(stateDir, pr);
    if (
      snapshot.ok &&
      snapshot.state.quotaPark === null &&
      snapshot.state.parked.length === 0
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
      dir: join(stateDir, entry),
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

/**
 * Read `drive-pr-<pr>.json` DIRECTLY — no `openStore`, no lock. This command
 * is read-only over lock state by design (see the module header); the same
 * reasoning extends to state: taking the state lock here would make a
 * diagnostic sweep a second writer contending with an actual driver for the
 * one thing single-instance locking exists to serialize, over a file this
 * function only ever reads. `isUsableState` is the SAME shape predicate
 * `store.read()` uses, so a file this rejects is one `store.read()` would
 * refuse too — never a false positive relative to the real reader.
 */
function readStateSnapshot(
  stateDir: string,
  pr: string,
): { ok: true; state: DriveState } | { ok: false } {
  try {
    const raw = readFileSync(join(stateDir, `drive-pr-${pr}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isUsableState(parsed, Number.parseInt(pr, 10))) return { ok: false };
    return { ok: true, state: parsed };
  } catch {
    return { ok: false };
  }
}

/**
 * What a driven worktree still holds, for `classifyDrive`'s
 * `DEAD_WITH_LEFTOVERS` check. `null` on ANY probe failure — including a
 * resolvable-but-empty upstream — rather than reporting a partial answer:
 * `DoctorLeftovers` has no per-field "unknown", so a probe this function cannot
 * complete must fail the WHOLE record rather than guess a boolean for the field
 * it could not determine.
 *
 * Three SEPARATE probes, deliberately not folded into `drive.ts`'s own
 * `leftoverReport`: that function has no notion of "unpushed" at all (a
 * stalled pass's own worktree is presumed pushed already, since a converged
 * drive certifies that before it ever returns), and it targets the CURRENT
 * process's cwd — this one targets an ARBITRARY other worktree by path.
 *
 * Exported for `drives.test.ts` — the fail-closed
 * nulls (no upstream, a missing worktree, a torn/absent git dir) are cheap to
 * exercise directly against a real scratch repo, without paying for a whole
 * `drives.ts --doctor` subprocess round trip per case.
 */
export async function gatherWorktreeLeftovers(
  worktree: string,
): Promise<DoctorLeftovers | null> {
  const timeoutSec = gitCallTimeoutSeconds();
  // `env: gitIdentityEnv()` on EVERY probe below, not just `cwd` — `cwd`
  // alone was never sufficient (`GIT_LOCATION_VARS`' own header in
  // `lib/proc.ts`). This command is routinely run from an operator's shell
  // and from a SessionStart hook, and a lefthook hook exports `GIT_DIR`/
  // `GIT_WORK_TREE` into exactly that environment; `GIT_DIR` alone is the
  // sharpest case, since git then treats `cwd` as the work tree while
  // resolving refs from the leaked dir — so `status` would answer for THIS
  // worktree while `@{u}..HEAD` answered for another repository entirely, and
  // `--doctor` would report a stranger's unpushed commits as this drive's
  // leftovers.
  const env = gitIdentityEnv();
  const dirty = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    { stderr: "ignore", timeoutSec, cwd: worktree, env },
  );
  if (dirty.code !== 0) return null;
  const op = await unconcludedGitOpMarker(timeoutSec, { cwd: worktree, env });
  if (!op.ok) return null;
  // A missing upstream is not "0 unpushed commits" and not "some unpushed
  // commits" — it is a DIFFERENT question this probe cannot answer, checked
  // STRUCTURALLY (does `@{u}` resolve at all) before ever asking `rev-list` to
  // count against it, rather than inferring the cause from `rev-list`'s own
  // exit code or stderr text (parse or pin, never pattern-match a failure's
  // cause).
  const upstream = await git(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    { stderr: "ignore", timeoutSec, cwd: worktree, env },
  );
  if (upstream.code !== 0) return null;
  const unpushedCount = await git(["rev-list", "--count", "@{u}..HEAD"], {
    stderr: "ignore",
    timeoutSec,
    cwd: worktree,
    env,
  });
  if (unpushedCount.code !== 0) return null;
  const n = Number.parseInt(unpushedCount.stdout.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return {
    uncommitted: dirty.stdout !== "",
    unpushed: n > 0,
    unconcludedOp: op.marker,
  };
}

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
  // and this one, or a corrupted/hand-edited state file) makes the subtraction
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
  const isLocal = samePidNamespace({
    host: row.host ?? "",
    platform: row.platform,
  });
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
    worktreePath !== null && noLiveDriver(row.state)
      ? await gatherWorktreeLeftovers(worktreePath)
      : null;
  return {
    lockState: row.state,
    progressAgeMs,
    stateReadable: snapshot.ok,
    passChild,
    quotaPark: snapshot.ok ? snapshot.state.quotaPark : null,
    parkedCount: snapshot.ok ? snapshot.state.parked.length : 0,
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
): Promise<LockRow[]> {
  // ONE process-table read for the whole sweep, taken before the fan-out
  // rather than once per row — see `snapshotProcesses`' own header for why
  // this is the expensive part and why sharing one instant across rows is
  // the more consistent answer as well as the cheaper one. Skipped entirely
  // when no row could use it, so the common "nothing but empty lock slots"
  // listing spawns no `ps` at all.
  const needsProcs = rows.some((r) => r.kind === "pr" && r.pid !== null);
  const procs = needsProcs ? await snapshotProcesses() : null;
  return Promise.all(
    rows.map(async (row) => {
      if (row.kind !== "pr") return row;
      const input = await gatherDoctorInput(stateDir, row, selfPath, procs);
      return { ...row, doctor: classifyDrive(input, new Date()) };
    }),
  );
}

function printHuman(stateDir: string, rows: LockRow[]): void {
  if (rows.length === 0) {
    console.log(`no drive locks under ${stateDir}`);
    return;
  }
  // A live driver holds two locks (worktree first, then PR) with one pid —
  // present each such pair as ONE drive, keyed by owner, with any unpaired or
  // non-live rows listed individually after it. The key carries the acquisition
  // timestamp too: one acquisition writes one diag to both locks, so `started`
  // distinguishes two acquisitions that collide on host/pid via pid reuse —
  // merging them would correlate an abandoned claim with another driver's PR
  // lock.
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
    if (diag !== null) {
      console.log(`    worktree: ${diag.worktree}`);
      console.log(`    since:    ${diag.started}`);
      console.log(`    log:      ${diag.log}`);
      console.log(`    account:  ${formatAccountIdentity(diag.account)}`);
    } else {
      console.log("    (claim predates diagnostics — pid/host only)");
    }
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
    // `attachDoctorVerdicts` already computed this for every `pr`-kind row —
    // including `empty`/`stale` ones, which is exactly the shape
    // `DEAD_WITH_LEFTOVERS` exists to name. Printing only WEDGED here (as
    // this listing did before) meant the single MOST actionable verdict —
    // stranded commits in a worktree nobody is driving — was computed and
    // then discarded, invisible on the default surface, and the line above
    // it read as "the next drive recovers it" with no hint that the tree
    // still holds real work.
    if (row.doctor?.verdict === "DEAD_WITH_LEFTOVERS") {
      console.log(`    ⚠ ${row.doctor.reason}`);
      if (row.doctor.recovery !== null) {
        console.log(`    recovery: ${row.doctor.recovery}`);
      }
    }
  }
}

/**
 * `--doctor`'s human rendering. One line per PR-kind row (the
 * classifier has nothing to say about a `worktree`-kind lock — see
 * `LockRow.doctor`'s own comment), naming the verdict, the reason
 * `classifyDrive` gave for it, and a recovery command where one exists.
 *
 * Every drive in the state universe is swept — `rows`, by the time it
 * reaches this function, is `main`'s MERGE of `listRows`' lock census and
 * `listStateOnlyRows`' extra rows for a `drive-pr-<PR>.json` with no
 * surviving lock directory (a drive that parked and then exited normally
 * has no lock left at all, and it is exactly that row this merge exists to
 * still report). An unreadable LOCK is still a
 * `contested`/`unreadable` `LockRow` here exactly as it is in the plain
 * listing, never silently dropped before it reaches this function.
 */
function printDoctor(stateDir: string, rows: readonly LockRow[]): void {
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
      continue;
    }
    const icon =
      d.verdict === "HEALTHY" ? "●" : d.verdict === "UNKNOWN" ? "○" : "⚠";
    console.log(`${icon} PR #${row.key} — ${d.verdict}: ${d.reason}`);
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
  const row = readLock(
    join(stateDir, await worktreeLockName()),
    "worktree",
    "this",
  );
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

async function stop(stateDir: string, pr: string): Promise<number> {
  const row = readLock(join(stateDir, `pr-drive-${pr}.lock`), "pr", pr);
  if (row.state === "empty") {
    console.log(`no drive holds PR #${pr}'s lock — nothing to stop.`);
    return 1;
  }
  if (row.state === "stale") {
    console.log(
      `PR #${pr}'s lock is stale (owner pid ${row.pid} no longer counts as live) — nothing to stop; the next drive recovers it.`,
    );
    return 1;
  }
  if (row.state !== "live") {
    console.log(
      `PR #${pr}'s lock has a ${row.state} claim — refusing to guess who to signal. Inspect: ${row.dir}`,
    );
    return 1;
  }
  const pid = row.pid as number;
  if (!samePidNamespace({ host: row.host ?? "", platform: row.platform })) {
    console.log(
      `PR #${pr}'s driver runs on ${row.host} (${row.platform ?? "unknown platform"}) — stop it from that PID namespace (pid ${pid}).`,
    );
    return 1;
  }
  const verified = await verifyDriverClaim(row, pid);
  if ("code" in verified) return verified.code;
  return stopVerifiedDriver(row, verified.owner);
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

async function requestVerifiedDriverStop(
  row: LockRow,
  owner: ProcessRow,
): Promise<boolean> {
  const pid = owner.pid;
  if (row.platform !== null && row.nonce !== null) {
    try {
      requestDriverStop(row.dir, row.nonce);
    } catch (error) {
      console.log(`cannot request stop of driver pid ${pid}: ${String(error)}`);
      return false;
    }
    console.log(
      `requested stop of driver pid ${pid} — it stops its pass tree, then releases its locks…`,
    );
  } else {
    // Existing POSIX drivers predate the file channel. Their signal handler
    // provides the same cleanup; untagged claims on Windows were refused above.
    if (!(await signalIdentityTargets([owner], "SIGTERM"))) return false;
    console.log(
      `sent SIGTERM to driver pid ${pid} — it stops its pass tree, then releases its locks…`,
    );
  }
  return true;
}

async function stopVerifiedDriver(
  row: LockRow,
  owner: ProcessRow,
): Promise<number> {
  const pid = owner.pid;
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
    process.platform === "win32" && row.platform !== null && row.nonce !== null
      ? join(row.dir, `processes.${row.nonce}`)
      : null;
  const registryState: WindowsTreeState = { root: owner, targets };
  const refreshRegistered = registryCompletionTracker(registry, registryState);
  if (!(await refreshRegistered())) {
    console.log(
      `driver pid ${pid}'s registry is incomplete; requesting cleanup while retaining its known process identities.`,
    );
  }
  if (!(await requestVerifiedDriverStop(row, owner))) return 1;
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
  );
}

/** Directory removal cannot turn an unreadable registration into completed work. */
export function registryCompletionTracker(
  registry: string | null,
  state: WindowsTreeState,
): (control?: ProcessTreeControl) => Promise<boolean> {
  let complete = false;
  return async (control = {}) => {
    if (registry === null) return true;
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
    return gone && root.complete && complete;
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
): Promise<number> {
  console.log(
    `driver pid ${owner.pid} outlived the ${graceSec}s grace — forcing its captured process identities to exit.`,
  );
  const confirmed = await forceKnownStopTargets(
    owner,
    targets,
    refreshRegistered,
    registryState,
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

async function main(): Promise<number> {
  let json = false;
  let hereMode = false;
  let stopPr = "";
  let doctorMode = false;
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "--json") json = true;
    else if (a === "--here") hereMode = true;
    else if (a === "--doctor") doctorMode = true;
    else if (a === "--stop") {
      stopPr = argv[i + 1] ?? "";
      i++;
      if (!isDigits(stopPr)) fail(2, "--stop takes a PR number");
    } else {
      fail(
        2,
        `usage: drives.ts [--json] | [--here] | [--stop <PR>] | [--doctor [--json]]`,
      );
    }
  }
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
  // runs on every session's own SessionStart hook, so merely opening an
  // otherwise-unused repository was minting a clone identity, creating the
  // state directory, and writing the migration marker purely to answer a
  // read-only banner check.
  if (hereMode) {
    let stateDir: string;
    try {
      stateDir = await peekResolvedStateDir();
    } catch {
      console.log(
        "⚠ drive-pr: cannot check this directory for a live drive loop (no resolvable state dir — not a git repository?).",
      );
      return 0;
    }
    return here(stateDir);
  }
  if (stopPr !== "") {
    // `resolveStateDir()` can refuse here specifically because an unmigrated
    // legacy footprint exists (`ensureMigratedFromLegacy`) — and the single
    // most likely cause of that footprint is exactly the live older
    // driver `--stop` exists to reach: its own lock is what the migration
    // guard is refusing on. Falling back to the raw legacy directory is what
    // actually lets that scenario be recovered from — without it, `--stop`
    // is unusable for the one case it is most needed, the same live-driver
    // scenario `migrate-legacy-state.ts`'s own refusal message points users at
    // this command to resolve.
    let stateDir: string;
    try {
      stateDir = await resolveStateDir();
    } catch (e) {
      // Narrowed to the migration-guard shape specifically, not every
      // `resolveStateDir()` failure — a relative-override or no-git-repo
      // refusal is a different, genuine problem that silently falling back to
      // the legacy directory would mask rather than surface.
      // `ensureMigratedFromLegacy` only ever refuses when `legacyFootprint`
      // found something, so an empty footprint here means this was NOT that
      // refusal — re-throw.
      const legacyDir = await resolveLegacyStateDir().catch(() => null);
      if (legacyDir === null || legacyFootprint(legacyDir).length === 0) {
        throw e;
      }
      stateDir = legacyDir;
    }
    return stop(stateDir, stopPr);
  }

  // Read-only listing, same reasoning as --here above: this must not mint a
  // clone identity or create/mark the state directory merely to enumerate it.
  const stateDir = await peekResolvedStateDir();
  const lockRows = listRows(stateDir);
  // `--doctor`'s population is `lock dirs ∪ drive-pr-*.json state files`
  // — the plain listing's and plain `--json`'s
  // stays LOCK ROWS ONLY, unchanged in kind (see `listStateOnlyRows`'s own
  // header for why that split is deliberate, not an oversight). This is also
  // what makes `--doctor --json` a genuinely DIFFERENT payload from plain
  // `--json`, not the no-op it used to be when this branch returned before
  // `doctorMode` was ever read.
  const rows = doctorMode
    ? [...lockRows, ...listStateOnlyRows(stateDir, lockRows)]
    : lockRows;
  // Classified UNCONDITIONALLY, not only under `--doctor`: the
  // acceptance bar for this feature is that `drives.ts --json` ALWAYS carries
  // the verdict, and the plain human listing's own "stalled" annotation reads
  // off the same `.doctor` field `printHuman` expects to already be
  // populated — one classification pass feeds every rendering, rather than
  // three call sites each deciding independently whether to run it.
  const doctored = await attachDoctorVerdicts(stateDir, rows, SELF);
  if (doctorMode) {
    if (json) {
      console.log(JSON.stringify({ stateDir, rows: doctored }, null, 2));
      return 0;
    }
    printDoctor(stateDir, doctored);
    return 0;
  }
  if (json) {
    console.log(JSON.stringify({ stateDir, rows: doctored }, null, 2));
    return 0;
  }
  printHuman(stateDir, doctored);
  return 0;
}

// Gated behind `import.meta.main`, not run at module scope unconditionally — the
// established pattern several siblings in this skill already use
// (`round-plan.ts`, `self-inflicted.ts`, `migrate-state-dir.ts`, …) so a pure
// helper like `gatherWorktreeLeftovers` can be imported directly by a test
// without ALSO running this file's own CLI against whatever `process.argv`
// the importing process happens to carry.
if (import.meta.main) runMain("drives.ts", main);
