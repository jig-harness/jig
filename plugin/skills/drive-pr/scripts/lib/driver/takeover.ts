/**
 * Replacing a driver that still holds a drive's locks: `drive.ts <PR>
 * --take-over`, in the same clone. When no driver of this clone holds the
 * drive, a driver in another clone is taken over through the pull request's
 * drive ledger instead (`ledger.ts`): admitted on a heartbeat older than the
 * lease window, and claimed on the pull request once the locks are held.
 *
 * Admitted against exactly two holders, both decided by `drives.ts --doctor`
 * rather than by the caller: one whose verdict is `WEDGED` (a live driver,
 * progress older than the stall threshold, no pass process under it), and one
 * whose process is gone with nothing left in its working tree (no uncommitted
 * changes, no unpushed commits, no unconcluded git operation). Against any
 * other holder the takeover refuses as exit `11` does, naming the verdict: a
 * driver that is making progress is never stopped, and a dead one's
 * leftovers are pushed or discarded by a person first, since a successor
 * driving around them would strand or overwrite them.
 *
 * A wedged holder is stopped with the identity check `drives.ts --stop`
 * performs, through that command itself. Once this driver holds the locks it
 * records the takeover in the drive state (who drove, who drives now, the
 * verdict, the round it resumes at), runs `reconcile-replied-threads.ts`
 * before the first triage, and carries the held batch over: a hold whose fix
 * was pushed is left for the round to resolve as usual; a hold whose promised
 * fix never landed is reopened with a superseding reply that says so, and the
 * first pass is told to redo the fix and hold it again or to triage it
 * afresh.
 */
import { ExitError, fail, isDigits, sleep } from "./../cli.ts";

import { helperTimeoutSeconds, run, tsArgv } from "./../proc.ts";

import type { ClaimDiag } from "./../claim.ts";

import {
  accountHash,
  formatAccountIdentity,
  resolveAccountIdentity,
} from "./../identity.ts";

import { worktreePathKey } from "./../state/actor.ts";

import type { HeldItem } from "./../state/schema.ts";

import { gatherWorktreeLeftovers } from "../../drives.ts";

import {
  drives,
  driveState,
  reconcileRepliedThreads,
  replyToThread,
} from "./paths.ts";

import { type DriveLock, liveHolder } from "./locks.ts";

import {
  admitAnsweredParks,
  admitQuotaRearm,
  armCommand,
  parseJson,
  readDriveState,
} from "./rearm.ts";

import { swallow } from "../../../../../shared/errors.ts";

import { isRecord } from "../../../../../shared/guards.ts";

import { SINGLE_INSTANCE_LOCK_EXIT } from "./settings.ts";

import {
  type LedgerIdentity,
  admitCrossCloneTakeover,
  mirrorNow,
} from "./ledger.ts";

/** One `drives.ts --doctor --json` row, as far as a takeover reads it. */
interface DoctorRowJson {
  kind: string;
  key: string;
  state: string;
  pid: number | null;
  host: string | null;
  diag: ClaimDiag | null;
  doctor: { verdict: string; reason: string; recovery: string | null } | null;
}

/** What an admitted takeover hands to `completeTakeover`. */
export interface TakeoverAdmission {
  verdict: "WEDGED" | "DEAD" | "STALE";
  fromActor: string | null;
  fromAccount: string | null;
  /** Admitted on another clone's stale ledger heartbeat: claimed on the PR. */
  crossClone?: true;
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

/**
 * Decide a takeover before any lock is taken, and stop a wedged holder.
 * Refuses (throws the exit) for every holder the module header excludes.
 */
export async function admitTakeover(
  pr: string,
  prLockDir: string,
  ledger: LedgerIdentity | null,
): Promise<TakeoverAdmission> {
  const row = await doctorRowFor(pr);
  if (row === "unreadable")
    fail(
      1,
      `drive.ts --take-over: could not read drives.ts --doctor for PR #${pr}; refusing to take over blind.`,
    );
  if (row === null || row.state === "empty") {
    // No driver of this clone holds it: a driver in another clone may, by
    // the pull request's drive ledger.
    const crossClone =
      ledger === null ? null : await admitCrossCloneTakeover(pr, ledger);
    if (crossClone !== null) return crossClone;
    fail(
      2,
      `drive.ts --take-over: no driver holds PR #${pr}'s lock, and its drive ledger names no running driver in another clone, so there is nothing to take over.`,
      "Re-arm it without --take-over.",
    );
  }
  const verdict = row.doctor?.verdict ?? "UNKNOWN";
  const from = {
    fromActor: actorOf(row.diag),
    fromAccount: row.diag === null ? null : accountHash(row.diag.account),
  };
  if (row.state === "live" && verdict === "WEDGED") {
    await stopWedgedHolder(pr, prLockDir, row);
    return { verdict: "WEDGED", ...from };
  }
  if (row.state === "stale") {
    await requireNoLeftovers(pr, row);
    console.error(
      `drive.ts --take-over: PR #${pr}'s previous driver (pid ${row.pid ?? "?"}) is gone and left nothing in its tree; taking the drive over.`,
    );
    return { verdict: "DEAD", ...from };
  }
  return fail(
    SINGLE_INSTANCE_LOCK_EXIT,
    `drive.ts --take-over: refusing to take over PR #${pr}.`,
    ...holderLines(row),
    "A takeover is admitted only against a WEDGED driver, or a dead one whose leftovers",
    "are pushed or discarded. Do not stop a driver that is making progress.",
  );
}

async function stopWedgedHolder(
  pr: string,
  prLockDir: string,
  row: DoctorRowJson,
): Promise<void> {
  console.error(
    `drive.ts --take-over: PR #${pr}'s driver is WEDGED; stopping it through drives.ts --stop.`,
  );
  for (const line of holderLines(row)) console.error(`  ${line}`);
  const stop = await run(tsArgv(drives, ["--stop", pr]), {
    stdout: "inherit",
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
  });
  if (stop.code !== 0)
    fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: drives.ts --stop ${pr} exited ${stop.code}; the holder may still be running. Not taking over.`,
    );
  // The stopped driver releases its locks on the way out; a forced one leaves
  // a claim whose pid is gone, which the acquisition below recovers.
  const deadline = Date.now() + helperTimeoutSeconds() * 1000;
  while (liveHolder(prLockDir) !== null) {
    if (Date.now() >= deadline)
      fail(
        SINGLE_INSTANCE_LOCK_EXIT,
        `drive.ts --take-over: PR #${pr}'s lock still reads live after the stop; not taking over.`,
      );
    await sleep(0.25);
  }
}

async function requireNoLeftovers(
  pr: string,
  row: DoctorRowJson,
): Promise<void> {
  const tree = row.diag?.worktree ?? "";
  const leftovers = tree === "" ? null : await gatherWorktreeLeftovers(tree);
  if (leftovers === null)
    fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: PR #${pr}'s previous driver is gone, but its working tree ${tree === "" ? "is not recorded" : `(${tree}) could not be inspected`} for leftovers.`,
      ...holderLines(row),
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
    fail(
      SINGLE_INSTANCE_LOCK_EXIT,
      `drive.ts --take-over: refusing to take over PR #${pr}: its previous driver is gone (DEAD_WITH_LEFTOVERS) and ${tree} still holds ${found.join(", ")}.`,
      ...holderLines(row),
      `Push or discard them first (git -C ${JSON.stringify(tree)} status --short), then take over.`,
    );
}

/**
 * Explain an exit-11 refusal: the holder's doctor verdict and, when a
 * takeover would be admitted, the command. Called with the refusal already
 * printed; never changes the exit.
 */
export async function explainHolder(
  lock: DriveLock,
  driveTs: string,
): Promise<void> {
  const holder = liveHolder(lock.dir);
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
    console.error(`  ${armCommand(driveTs, pr, " --take-over")}`);
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
  fn: () => T,
): Promise<T> {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ExitError && e.code === SINGLE_INSTANCE_LOCK_EXIT)
      await explainHolder(lock, driveTs).catch(() => undefined);
    throw e;
  }
}

async function driveStateRun(
  args: string[],
  stdin?: string,
): Promise<{ code: number; stdout: string }> {
  return run(tsArgv(driveState, args), {
    stderr: "inherit",
    timeoutSec: helperTimeoutSeconds(),
    ...(stdin === undefined ? {} : { stdin }),
  });
}

const REOPEN_REPLY =
  "Reopened: the driver that posted the reply above stopped before the fix it promised was pushed, and another driver has taken this pull request's drive over. It redoes the fix and holds this thread again, or triages the finding afresh.";

/**
 * Reopen one hold whose promised fix never landed: a superseding reply on
 * its thread, then the hold released. Returns what the pass is told.
 */
async function reopenHold(pr: string, item: HeldItem): Promise<string> {
  let replied = "";
  if (item.kind === "thread") {
    const reply = await run(tsArgv(replyToThread, [item.key, "--no-outcome"]), {
      stdin: REOPEN_REPLY,
      stderr: "inherit",
      timeoutSec: helperTimeoutSeconds(),
      env: { ...process.env, DRIVE_PR_TARGET: pr },
    });
    replied =
      reply.code === 0
        ? "; superseding reply posted"
        : `; the superseding reply FAILED (exit ${reply.code}) — post it yourself`;
  }
  const release = await driveStateRun([
    "release-held",
    pr,
    "--key",
    item.key,
    "--if-present",
    ...(item.commentUrl === undefined
      ? []
      : ["--if-comment-url", item.commentUrl]),
  ]);
  if (release.code !== 0)
    return `- [${item.kind}] ${item.key}: could NOT be released (exit ${release.code}); it stays held${replied}`;
  return `- [${item.kind}] ${item.key} (was ${item.outcome}, round ${item.round})${replied}`;
}

/**
 * Finish an admitted takeover once this driver holds the locks: record it,
 * reconcile replied threads, carry the held batch over. Returns the notice
 * the first pass reads in `$DRIVE_PR_PASS_NOTICE`.
 */
export async function completeTakeover(
  pr: string,
  admission: TakeoverAdmission,
  agent: string[],
  botsOnly: boolean,
): Promise<string> {
  const heldRes = await driveStateRun(["held", pr]);
  const parsed =
    heldRes.code === 0 ? parseJson(heldRes.stdout, "drive-state.ts held") : [];
  const held: HeldItem[] = Array.isArray(parsed)
    ? parsed.filter(
        (h): h is HeldItem =>
          isRecord(h) &&
          typeof h.key === "string" &&
          (h.kind === "thread" || h.kind === "finding") &&
          typeof h.actor === "string",
      )
    : [];
  const reconcile = await run(
    tsArgv(reconcileRepliedThreads, [pr, ...(botsOnly ? ["--bots-only"] : [])]),
    { stdout: "pipe", stderr: "inherit", timeoutSec: helperTimeoutSeconds() },
  );
  // The first round's gate runs the same sweep before it evaluates anything,
  // so a failed run here delays the reconciliation by one gate, never skips it.
  console.error(
    `takeover: ran reconcile-replied-threads.ts before the first triage (exit ${reconcile.code}${reconcile.code === 0 ? "" : "; the first gate's own sweep runs it again"}).`,
  );
  const unlanded = held.filter(
    (h) =>
      h.verifiedSha === undefined &&
      (admission.fromActor === null || h.actor === admission.fromActor),
  );
  const reopened: string[] = [];
  const lines: string[] = [];
  for (const item of unlanded) {
    lines.push(await reopenHold(pr, item));
    reopened.push(item.key);
  }
  const toAccount = accountHash(resolveAccountIdentity(agent));
  const record = await driveStateRun(
    ["takeover", pr],
    JSON.stringify({
      fromActor: admission.fromActor,
      fromAccount: admission.fromAccount,
      toAccount,
      verdict: admission.verdict,
      reopened,
    }),
  );
  console.error(
    record.code === 0
      ? `takeover: recorded in the drive state (from ${admission.fromActor ?? "an unnamed tree"}, account ${admission.fromAccount ?? "unknown"}, to account ${toAccount ?? "unknown"}, verdict ${admission.verdict}, ${reopened.length} hold(s) reopened).`
      : `takeover: could not record the takeover (drive-state.ts exited ${record.code}); driving on.`,
  );
  const from = {
    WEDGED: "a wedged driver",
    DEAD: "a dead driver",
    STALE:
      "another clone's driver whose ledger heartbeat was past the lease window",
  }[admission.verdict];
  const notice = [
    `TAKEN OVER: this drive was taken over from ${from} and resumes at its durable round.`,
  ];
  if (lines.length > 0)
    notice.push(
      "These holds' promised fixes never landed, and they are reopened. For each, redo the fix and hold it again with a fresh outcome reply, or triage it afresh:",
      ...lines,
    );
  else notice.push("No held item was left waiting on an unpushed fix.");
  return notice.join("\n");
}

/**
 * Pick the drive up from its durable state once this driver holds the locks:
 * refuse a re-arm behind a quota wall the pass's account cannot pass, finish
 * an admitted takeover, and unpark items a person has answered. Returns the
 * exit for a refusal, else the first pass's notice (`''` for none).
 */
export async function pickUpDrive(
  pr: string,
  admission: TakeoverAdmission | null,
  opts: {
    agent: string[];
    botsOnly: boolean;
    windowReopened: boolean;
    dryRun: boolean;
  },
): Promise<number | string> {
  const state = await readDriveState(pr);
  const quotaExit =
    state === null
      ? null
      : admitQuotaRearm(state, opts.agent, opts.windowReopened, new Date());
  if (quotaExit !== null) return quotaExit;
  const takeover =
    admission === null
      ? ""
      : await completeTakeover(pr, admission, opts.agent, opts.botsOnly);
  // A takeover is written to the ledger at once, not at the next boundary.
  if (admission !== null) await mirrorNow(pr);
  const notices = [
    takeover,
    state === null ? "" : await admitAnsweredParks(state, opts.dryRun),
  ];
  return notices.filter((part) => part !== "").join("\n\n");
}
