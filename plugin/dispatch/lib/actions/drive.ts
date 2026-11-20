/**
 * `--apply` for drives: start each re-arm and takeover the plan wants, in
 * order, as a headless pass in the pull request's workspace, on an
 * admitted account. For each one:
 *
 * 1. read the pull request and its ledger again, and go on only when its
 *    facts are the ones the plan acted on (for a re-drive, the change it acts
 *    on too; for an arm its `drive` label asked for, still no ledger at the
 *    same head) and no `hold` label has appeared on it;
 * 2. admit an account (accounts.ts), and check that the wrapper's
 *    environment resolves to that account's identity;
 * 3. use the workspace that holds the pull request once the runtime proves
 *    it is still the pull request's checkout (`verifyWorkspace`), or open
 *    one named for the stage and the pull request (`dispatched` in
 *    `runtime/port.ts`), whose open proves it, under the launch record's id
 *    minted here;
 * 4. write the launch record, which holds the slot from here on;
 * 5. claim the launch where another host dispatching the repository reads
 *    it (`shared-launches.ts`): a current claim of another host's with no
 *    end holds the launch, and a claim that loses its attempt is withdrawn;
 *    either gives the record back and starts nothing;
 * 6. call the runtime's `launch` under the record's token (launch.ts).
 *
 * A takeover of a driver another host started is admitted on a free slot,
 * as a re-arm is, since this host has no record of that driver's to take
 * the slot of.
 *
 * Before any of that, a pending record of the repository whose launch got
 * no answer is retried once, under its own record and token, never as a
 * fresh launch, and only once its recorded workspace is proven again.
 * Everything else in the plan is reported, as without `--apply`.
 */
import { worktreePathKey } from "../../../skills/drive-pr/scripts/lib/state/actor.ts";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { git, gitIdentityEnv } from "../../../shared/proc.ts";
import { idleBlocksStart } from "../automation.ts";
import { cloneId } from "../../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { peekCloneKey } from "../../../skills/drive-pr/scripts/lib/state/clone-key.ts";
import { readCloneKey, takeoverHostDriver } from "../host-drivers.ts";
import type { UnrecordedDriver } from "../host-drivers.ts";
import { consumeRearm, pendingRearm } from "./rearm-request.ts";
import { admittedVendor, codexLaunchFields, type Slots } from "../accounts.ts";
import { DRIVE_EXIT } from "../../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  type LaunchRecord,
  newRecordId,
  newToken,
  redrivenChanges,
  writeRecord,
} from "../launches.ts";
import {
  type Dispatched,
  dispatched,
  type SessionsReport,
} from "../runtime/port.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { failureText } from "../text.ts";
import { RECOVERY_FACTS, sameFacts } from "../recovery-facts.ts";
import { stewardFresh } from "../steward-apply.ts";
import { markStewardEffect } from "../steward.ts";
import {
  recoveryReplayReading,
  startCheckedRecovery,
} from "../steward-recovery.ts";
import { workspaceOfTree } from "../stall-tree.ts";
import type {
  Action,
  DrivenPr,
  LaunchOutcome,
  LedgerClass,
  RepoReport,
  RepoTarget,
  StaleCause,
} from "../types.ts";
import { armsUnarmed, factsOf } from "./drive-hold.ts";
import { pullStateLabels } from "../forge.ts";
import { launchHeads } from "../failed-rearms.ts";
import {
  accountBlock,
  admitAccount,
  type ApplyState,
  type ReplayBlock,
  dropPendingRecord,
  isTakeover,
  type LaunchClaimer,
  type Opened,
  openedFor,
  openWithinBudget,
  outOfTime,
  timeLeftMs,
  replay,
  replayable,
  rotated,
  waits,
} from "./launch.ts";
import {
  ghCallTimeoutSeconds,
  KILL_ESCALATE_MS,
} from "../../../skills/drive-pr/scripts/lib/proc.ts";
import { failedRearmRequest, rearmTimedOut } from "./retire-rearm.ts";
import { currentIso } from "../../../shared/time.ts";

export type { ApplyState } from "./launch.ts";

/** A fresh read of one pull request's drive, whether a person's `hold` label is on it, and how a launch claims it where another host reads it. */
export interface FreshDrive {
  /** The drive read again; a failure when the pull request or its ledger does not read. */
  read: (pr: number, steward?: boolean) => Promise<Outcome<DrivenPr | null>>;
  held: (pr: DrivenPr) => boolean;
  /** Whether `dispatch.labels` allows the tick to write a label; `false` leaves every rearm acknowledgment pending. */
  labelWrites?: boolean;
  claimer?: LaunchClaimer;
  /** Pull requests whose place in a serialized group this tick cannot tell, by number and why: no pending launch of theirs is replayed. */
  unplaced?: ReadonlyMap<number, string>;
}

async function consumeRequest(
  state: ApplyState,
  record: LaunchRecord,
  result: LaunchOutcome,
  fresh: FreshDrive,
): Promise<void> {
  if (fresh.labelWrites === false) {
    result.detail +=
      "; rearm request was carried out but dispatch.labels is disabled, so its label stays until labels are enabled again; this launch record prevents another launch until its removal is acknowledged";
    return;
  }
  const consumed = await acknowledgeRequest(state, record, fresh);
  if (!consumed.ok)
    result.detail += `; rearm request was carried out but its label could not be removed: ${consumed.failure.reason}; this launch record prevents another launch until its removal is acknowledged`;
}

/** The most forge calls one fresh drive reading makes: the view, its threads and its ledger reads. */
const FRESH_READ_CALLS = 4;

/** Whether the request label of a closed pull request is already gone, read within the tick's room. */
async function closedRequestRetired(
  state: ApplyState,
  record: LaunchRecord,
  room: (calls: number) => boolean,
  later: () => Outcome<boolean, "refused">,
): Promise<Outcome<boolean, "refused">> {
  const left = timeLeftMs(state);
  if (!room(1)) return later();
  const terminal = await pullStateLabels(
    record.repo,
    Number(record.pr),
    left === null ? undefined : Math.floor((left - KILL_ESCALATE_MS) / 1000),
  );
  if (!terminal.ok)
    return failed("refused", terminal.failure.reason, terminal.failure.cause);
  return terminal.value.state !== "OPEN" &&
    !terminal.value.labels.includes(record.rearmLabel ?? "")
    ? ok(false)
    : failed(
        "refused",
        "the request label on the closed pull request still needs retirement",
      );
}

/** Whether the pull request still carries the record's own request; the fresh read starts only with room for each forge call. */
async function requestStands(
  state: ApplyState,
  record: LaunchRecord,
  fresh: FreshDrive,
): Promise<Outcome<boolean, "refused">> {
  const callMs = ghCallTimeoutSeconds() * 1000 + KILL_ESCALATE_MS;
  const room = (calls: number) => {
    const left = timeLeftMs(state);
    return left === null || left >= calls * callMs;
  };
  const later = () =>
    failed(
      "refused" as const,
      "the tick deadline has no room to read the pull request again for rearm acknowledgment; a later tick retries it",
    );
  if (!room(FRESH_READ_CALLS)) return later();
  const read = await fresh.read(Number(record.pr));
  if (!read.ok) {
    if (read.failure.code !== "not-open")
      return failed("refused", read.failure.reason, read.failure.cause);
    return closedRequestRetired(state, record, room, later);
  }
  const pr = read.value;
  if (pr?.readFailed === true) return failed("refused", pr.why);
  return ok(
    pr !== null &&
      pr.evidence.rearmLabel === record.rearmLabel &&
      pr.evidence.rearmRequestId === record.rearmRequestId,
  );
}

/** An acknowledgment belongs to its request, even if a newer one uses the same label. */
function acknowledgeRequest(
  state: ApplyState,
  record: LaunchRecord,
  fresh: FreshDrive,
): ReturnType<typeof consumeRearm> {
  return consumeRearm(
    record,
    state.root,
    undefined,
    () => timeLeftMs(state),
    () => requestStands(state, record, fresh),
  );
}

const HELD = "a person's hold label is on it now";

/**
 * A replay that may start the drive names the heads it starts at, as a first
 * launch does: the pull request's and its branch's may have moved since the
 * record was written, and a failure of the replay is weighed by the heads it
 * launched at. Only a record none of whose launches may have started is
 * refreshed; one an earlier launch answered or lost, or whose launch was called
 * and left no answer, keeps the heads it was written with, which that launch
 * acted on. Heads that do not read leave the
 * record with none, which a re-arm is held by nothing for; a later tick reads
 * them again for such a record, since it still never started.
 */
async function refreshHeads(
  state: ApplyState,
  record: LaunchRecord,
  read: DrivenPr,
): Promise<void> {
  if (
    record.action !== "rearm" ||
    record.launchCalled === true ||
    !record.attempts.every((a) => a.outcome === "failed")
  )
    return;
  const heads = await launchHeads(
    record.repo,
    read,
    undefined,
    timeLeftMs(state),
  );
  if (heads === (record.heads ?? null)) return;
  if (heads === null) delete record.heads;
  else record.heads = heads;
  writeRecord(record, state.root);
}

/** Retry, once and under its own key, each pending record of `repo` whose launch got no answer. */
async function retryPending(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  fresh: FreshDrive,
): Promise<void> {
  for (const record of replayable(state, repo.slug, ["rearm", "takeover"])) {
    const action = { target: `PR #${record.pr}`, stage: "rearm" } as Action;
    let blocked: string | ReplayBlock | null =
      record.pr === null ? null : (fresh.unplaced?.get(record.pr) ?? null);
    blocked ??= await retryBlocked(state, repo, record, fresh);
    let claim: number | null = null;
    if (blocked === null) {
      const taken = await unclaimed(state, record, fresh.claimer);
      blocked = taken.blocked;
      claim = taken.claim;
    }
    const result = await replay(state, record, action, blocked);
    report.launches.push(result);
    if (
      record.rearmLabel &&
      (result.outcome === "retried" || result.outcome === "launched")
    )
      await consumeRequest(state, record, result, fresh);
    // A replay that gave the record back starts nothing: its claim goes with it, as a first launch's does.
    if (claim !== null && !state.records.some((r) => r.record.id === record.id))
      await fresh.claimer?.release(record, claim);
  }
}

/**
 * A pending record's claim is checked where another host reads it before
 * every replay: a record never launched (a tick stopped between writing it
 * and its launch) may never have been claimed, and one that was launched
 * without an answer may have lost its claim since, to another host's or to a
 * person's deletion. It claims now, which is a no-op while its own claim
 * holds the launch, and a claim refused gives the record back. Why it must
 * not be replayed (`null` when it may) and the claim that holds it, to give
 * back should the replay start nothing.
 */
async function unclaimed(
  state: ApplyState,
  record: LaunchRecord,
  claimer: LaunchClaimer | undefined,
): Promise<{ blocked: string | null; claim: number | null }> {
  if (claimer === undefined) return { blocked: null, claim: null };
  const taken = await claimer.claim(record, true);
  if (!("refused" in taken)) return { blocked: null, claim: taken.claim };
  const why = `its launch is not claimed where another host reads it: ${taken.refused}`;
  if (taken.uncertain === true)
    return { blocked: `${why}; the record is kept`, claim: null };
  const blocked = dropPendingRecord(state, record)
    ? `${why}; the record is given back`
    : `${why}; the record is kept, since its launch started meanwhile`;
  return { blocked, claim: null };
}

const IDLE =
  "it is an automation pull request that needs no work now (no failing check, no conflict, no unresolved thread)";

/** Whether a pull request no longer carries the rearm request `id`: another one, none, or one past its lifetime. */
function requestMoved(pr: DrivenPr, id: unknown): boolean {
  return (
    pr.evidence.rearm !== true ||
    pr.evidence.rearmRequestId !== id ||
    rearmTimedOut(pr)
  );
}

/** Whether a record's rearm request ended before any launch of it started: its pull request closed or its request moved. */
function unstartedRequestEnded(
  record: LaunchRecord,
  again: Outcome<DrivenPr | null>,
): boolean {
  if (
    record.rearmRequestId === undefined ||
    record.launchCalled === true ||
    record.attempts.length > 0
  )
    return false;
  if (!again.ok) return again.failure.code === "not-open";
  const live = again.value;
  return (
    live === null ||
    (live.readFailed !== true && requestMoved(live, record.rearmRequestId))
  );
}

/** Why a pending record's launch must not be replayed now; `null` when it may. */
async function retryBlocked(
  state: ApplyState,
  repo: RepoTarget,
  record: LaunchRecord,
  fresh: FreshDrive,
): Promise<string | ReplayBlock | null> {
  let again: Outcome<DrivenPr | null>;
  try {
    again = await fresh.read(
      record.pr as number,
      record.stewardDecision !== undefined,
    );
  } catch (error) {
    return `its ledger cannot be read again: ${failureText(error)}`;
  }
  if (unstartedRequestEnded(record, again) && dropPendingRecord(state, record))
    return "the rearm request ended and its unstarted launch record was released";
  if (!again.ok)
    return `its ledger cannot be read again: ${again.failure.reason}`;
  const verified = recoveryReplayReading(
    record,
    again.value,
    fresh.held,
    state.root,
  );
  if (!verified.ok) return verified.failure.reason;
  const read = verified.value;
  if (!sameFacts(record.facts, factsOf(read)))
    return `its ledger changed since the launch (now ${factsOf(read)})`;
  if (record.rearmLabel != null && requestMoved(read, record.rearmRequestId))
    return "the rearm request changed or expired since the launch was recorded";
  const unwanted = classBlocked(record, read);
  if (unwanted !== null) return unwanted;
  // A stop on a conflict stands whatever moved since: its base moves often, and
  // this record holds the pull request until its launch is replayed. The replay
  // then acts on the change read now, so the record names that one, and keeps
  // the one an earlier launch may already have acted on.
  const blocked =
    record.redrive?.conflictStop === true
      ? replayedChange(state, record, read)
      : changedStale(record.redrive, read);
  if (blocked !== null) return blocked;
  const stopped =
    (await replayOriginalTree(record, read)) ??
    (await replayWorkspace(state, repo, record, read)) ??
    (await accountBlock(state, record));
  if (stopped === null) await refreshHeads(state, record, read);
  return stopped;
}

/** Original-tree recoveries retain their actor and clone check on replay. */
async function replayOriginalTree(
  record: LaunchRecord,
  read: DrivenPr,
): Promise<string | null> {
  if (
    record.redrive?.uncleanTree === true ||
    record.rearmLabel != null ||
    record.stewardDecision !== undefined
  ) {
    if (record.workspace === null)
      return "the original workspace is no longer recorded";
    const different = await originalTree(
      record.workspace.path,
      String(read.evidence.driverActor),
      String(read.evidence.driverClone),
    );
    if (different !== null) return different.why;
  }
  return null;
}

/**
 * Why a pending record's workspace is not proven to be its pull request's
 * checkout now; `null` once it is. The workspace may have changed since the
 * launch that got no answer, so a replay proves it again, as a first launch
 * into a workspace it did not open does.
 */
async function replayWorkspace(
  state: ApplyState,
  repo: RepoTarget,
  record: LaunchRecord,
  read: DrivenPr,
): Promise<string | null> {
  if (record.workspace === null) return "its workspace is no longer recorded";
  return unproven(state, repo, record.workspace, read.number, read.head);
}

/**
 * Why a workspace this launch did not open is not proven to be the pull
 * request's checkout (`SessionRuntime.verifyWorkspace`); `null` once it is.
 * The proof changes nothing in the workspace, so a tree a stop left work in
 * keeps that work whatever it answers.
 */
async function unproven(
  state: ApplyState,
  repo: RepoTarget,
  workspace: { id: string; path: string },
  pr: number,
  head: string,
): Promise<string | null> {
  const late = outOfTime(state);
  if (late !== null) return late;
  let why: string | null;
  try {
    why = await state.runtime.verifyWorkspace(
      repo,
      workspace,
      { pr, head },
      timeLeftMs(state) ?? undefined,
    );
  } catch (error) {
    why = failureText(error);
  }
  return why === null
    ? null
    : `the workspace ${workspace.path} is not proven to be PR #${pr}'s checkout, so nothing runs in it and its work stays as it is: ${why}`;
}

/** An existing workspace the launch runs in once it is proven, or its refusal. */
async function provenWorkspace(
  state: ApplyState,
  repo: RepoTarget,
  pr: number,
  head: string,
  found: { id: string; path: string },
): Promise<Opened> {
  const workspace = { id: found.id, path: found.path };
  const why = await unproven(state, repo, workspace, pr, head);
  return why === null ? { workspace } : { refused: why };
}

/**
 * Why a pending record's launch no longer acts on the class its ledger reads
 * now; `null` when it does. A takeover of a driver no launch started stands
 * only while this host still shows that driver's run ended.
 */
function classBlocked(record: LaunchRecord, read: DrivenPr): string | null {
  return idleBlocksStart(read, true) ? IDLE : classChanged(record, read);
}

/** Why a pending record's launch no longer acts on the class its ledger reads now, by the class alone. */
function classChanged(record: LaunchRecord, read: DrivenPr): string | null {
  const takeover = record.action === "takeover";
  const want = wantedClass(takeover, record.redrive, record.facts);
  // A pending conflict repair still owns its launch when the park's answers
  // or mergeability change. Replay under the same token instead of leaving
  // the pending record holding the park's ordinary re-arm forever.
  const parkedReplay =
    record.redrive?.conflictStop === true &&
    read.evidence.exit === DRIVE_EXIT.HITL_PARKED &&
    (read.class === "parked" || read.class === "re-armable");
  if (read.class !== want && !parkedReplay)
    return `its ledger now reads ${read.class}`;
  const gone =
    takeover &&
    record.replaces === null &&
    record.facts.startsWith(RECOVERY_FACTS);
  return gone && read.evidence.driverGone !== true
    ? `this host no longer shows its driver's run ended: ${String(read.evidence.driverCheck)}`
    : null;
}

/**
 * A record that stopped on a conflict acts on the change read now: it names
 * that one and keeps the ones an earlier launch may have acted on. Why it must
 * not, when a launch record (its own history included) already re-drove that
 * change; `null` when it may.
 */
function replayedChange(
  state: ApplyState,
  record: LaunchRecord,
  read: DrivenPr,
): string | null {
  const redrive = record.redrive;
  if (redrive == null || read.stale === undefined) return null;
  const change = read.stale.change;
  if (change === redrive.change) return null;
  const done = state.records.find(
    (r) =>
      r.record.repo === record.repo &&
      r.record.pr === record.pr &&
      r.record.redrive != null &&
      redrivenChanges(r.record.redrive).includes(change),
  );
  if (done !== undefined)
    return `launch record ${done.record.id} already re-drove the change it shows now`;
  record.redrive = {
    ...read.stale,
    earlier: [...(redrive.earlier ?? []), redrive.change],
  };
  return null;
}

/** The class a launch acts on: a takeover's `silent`, a re-drive's `stale`, a labelled arm's `unarmed`, any other re-arm's `re-armable`. */
function wantedClass(
  takeover: boolean,
  redrive: StaleCause | null | undefined,
  facts: string | null | undefined,
): LedgerClass {
  if (takeover) return "silent";
  if (armsUnarmed(facts)) return "unarmed";
  return redrive == null ? "re-armable" : "stale";
}

/** Why a pull request no longer shows the change a re-drive acts on; `null` when it still does. */
function changedStale(
  redrive: StaleCause | null | undefined,
  fresh: DrivenPr,
): string | null {
  if (redrive == null || fresh.stale?.change === redrive.change) return null;
  return `its pull request changed since the plan read it (now ${fresh.stale?.cause ?? fresh.why})`;
}

/** The fresh read: the ledger, and a stale one's pull request, must still say what the plan acted on, and no hold label stand on it. */
function stillWanted(
  action: Action,
  fresh: DrivenPr | null,
  held: FreshDrive["held"],
): string | null {
  if (fresh === null) return "its ledger cannot be read again";
  if (held(fresh)) return HELD;
  if (!sameFacts(factsOf(fresh), action.facts))
    return `its ledger changed since the plan read it (now ${factsOf(fresh)})`;
  const want = wantedClass(isTakeover(action), action.redrive, action.facts);
  if (fresh.class !== want)
    return `its ledger now reads ${fresh.class}: ${fresh.why}`;
  // A steward's rearm marks its fresh read itself; no label request stands behind it.
  if (
    action.steward === undefined &&
    (action.evidence.rearm === true || fresh.evidence.rearm === true) &&
    (fresh.evidence.rearm !== action.evidence.rearm ||
      requestMoved(fresh, action.evidence.rearmRequestId))
  )
    return "the rearm request changed or expired since the plan read it";
  if (idleBlocksStart(fresh)) return IDLE;
  if (action.takeoverGone !== undefined && fresh.evidence.driverGone !== true)
    return `this host no longer shows its driver's run ended: ${String(fresh.evidence.driverCheck)}`;
  return changedStale(action.redrive, fresh);
}

/**
 * Why a listed workspace is not the stopped driver's tree; null only after both identities match.
 * `proven` is true when the identities were read and differ, false when they could not be read.
 */
async function originalTree(
  path: string,
  actor: string,
  clone: string,
): Promise<{ why: string; proven: boolean } | null> {
  try {
    if (`wt-${worktreePathKey(realpathSync(path))}` !== actor)
      return {
        why: `${path}: its actor differs from the stopped driver's ${actor}`,
        proven: true,
      };
    const common = await git(["rev-parse", "--git-common-dir"], {
      cwd: path,
      env: gitIdentityEnv(),
      stderr: "pipe",
      timeoutSec: 10,
    });
    if (common.code !== 0)
      return {
        why: `${path}: its clone identity cannot be read (git exit ${common.code}: ${common.stderr.trim()})`,
        proven: false,
      };
    const local = peekCloneKey(resolve(path, common.stdout.trim()));
    if (local !== null && cloneId(local) === clone) return null;
    return {
      why: `${path}: its clone identity ${local === null ? "missing" : cloneId(local)} differs from the stopped driver's ${clone}`,
      proven: local !== null,
    };
  } catch (error) {
    return {
      why: `${path}: its original-tree identity cannot be read: ${failureText(error)}`,
      proven: false,
    };
  }
}

/**
 * The workspace a drive launch runs in: an existing one (the tree a stop left
 * work in, the stopped driver's original tree, or the one workspace joined to
 * the pull request on its head branch), proven before it is used, or one the
 * runtime opens.
 */
async function workspaceFor(
  state: ApplyState,
  repo: RepoTarget,
  pr: number,
  head: string,
  sessions: SessionsReport,
  named: Dispatched,
  tree: string | undefined,
  originalActor: string | null,
  originalClone: string,
): Promise<Opened & { missingOriginal?: true }> {
  // A stall or a deadline that left work runs where the work is, or not at all: a fresh
  // tree would not carry it.
  if (tree !== undefined && originalActor === null) {
    const own = sessions.ok
      ? workspaceOfTree(sessions.workspaces, tree)
      : undefined;
    return own === undefined
      ? {
          refused: `the stop left work in its tree (${tree}), which no open workspace holds now; a fresh tree would not carry it`,
        }
      : provenWorkspace(state, repo, pr, head, own);
  }
  const candidates = sessions.ok
    ? sessions.workspaces.filter(
        (w) =>
          w.prs.includes(pr) && (originalActor !== null || w.branch === head),
      )
    : [];
  const verified = await Promise.all(
    candidates.map((w) =>
      originalActor === null
        ? Promise.resolve(null)
        : originalTree(w.path, originalActor, originalClone),
    ),
  );
  const matched = candidates.filter((_, i) => verified[i] === null);
  const mismatched = verified.filter((v) => v !== null);
  const held = matched[0];
  if (matched.length === 1 && held !== undefined)
    return provenWorkspace(state, repo, pr, head, held);
  if (originalActor !== null)
    return {
      ...(sessions.ok && originalGone(candidates.length, mismatched)
        ? { missingOriginal: true }
        : {}),
      waits: `recovery requires exactly one existing tree linked to the pull request and matching the stopped driver's actor and clone; no replacement workspace is opened${mismatched.length === 0 ? "" : `: ${mismatched.map((v) => v.why).join("; ")}`}`,
    };
  return openWithinBudget(state, repo, { pr, head, dispatched: named });
}

/** Whether no listed workspace could be the stopped driver's tree: none is linked, or every one is proven another. */
function originalGone(
  candidates: number,
  mismatched: { proven: boolean }[],
): boolean {
  return (
    candidates === 0 ||
    (mismatched.length === candidates && mismatched.every((v) => v.proven))
  );
}

/** The ledger's round, which the launch's outcome row counts its rounds from; `null` when the ledger does not say. */
function roundOf(pr: DrivenPr): number | null {
  const round = pr.evidence.round;
  return typeof round === "number" ? round : null;
}

/** The record fields identifying the host driver this launch takes over. */
function hostDriverReplacement(
  holder: UnrecordedDriver | undefined,
): Pick<LaunchRecord, "replacesHostDriver"> {
  return holder === undefined
    ? {}
    : {
        replacesHostDriver: {
          clone: holder.driver.clone,
          pr: holder.driver.pr,
          since: holder.driver.since,
        },
      };
}

/** The admitted drive launch recorded before the runtime starts it. */
function driveRecord(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  pr: DrivenPr,
  slots: Slots,
  workspace: { id: string; path: string },
  id: string,
  named: Dispatched,
  heads: string | null,
): LaunchRecord {
  const kind = isTakeover(action) ? "takeover" : "rearm";
  const clone = readCloneKey(repo.path);
  const holder = takeoverHostDriver(
    action.takeoverHolder,
    state.drivers,
    state.table.map((entry) => entry.account),
    state.records,
    clone,
    pr.number,
  );
  return {
    version: 1,
    ...(action.steward === undefined
      ? {}
      : { stewardDecision: action.steward.id }),
    id,
    token: newToken(),
    action: kind,
    repo: repo.slug,
    repoPath: repo.path,
    pr: pr.number,
    account: slots.account.name,
    vendor: admittedVendor(slots.account),
    configDir: slots.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    passTimeoutSec: state.passDeadlineSec,
    ...codexLaunchFields(state.codexOptIn),
    replaces: action.takeover ?? null,
    ...hostDriverReplacement(holder),
    facts: action.facts ?? factsOf(pr),
    createdAt: currentIso(),
    workspace,
    attempts: [],
    item: null,
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: null,
    marker: null,
    round: roundOf(pr),
    redrive: action.redrive ?? null,
    ...(heads === null ? {} : { heads }),
    ...(typeof pr.evidence.rearmRequestId === "number"
      ? { rearmRequestId: pr.evidence.rearmRequestId }
      : {}),
    rearmLabel:
      pr.evidence.rearm === true && typeof pr.evidence.rearmLabel === "string"
        ? pr.evidence.rearmLabel
        : null,
    mark: named.mark,
  };
}

/** One planned re-arm or takeover, through its fresh read, admission, workspace, shared claim and launch. */
async function launchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  fresh: DrivenPr | null,
  sessions: SessionsReport,
  drive: FreshDrive,
  report: RepoReport,
): Promise<LaunchOutcome> {
  const late = outOfTime(state);
  if (late !== null) return waits(action, late);
  const changed = stillWanted(action, fresh, drive.held);
  if (changed !== null) return waits(action, changed);
  const admitted = await admitAccount(
    state,
    repo.slug,
    action,
    0,
    readCloneKey(repo.path),
  );
  if ("outcome" in admitted) return admitted.outcome;
  const slots = admitted.slots;
  const pr = fresh as DrivenPr;
  const id = newRecordId();
  const kind = isTakeover(action) ? "takeover" : "rearm";
  const named = dispatched(kind, `#${pr.number}`, id);
  const opening = await workspaceFor(
    state,
    repo,
    pr.number,
    pr.head,
    sessions,
    named,
    action.redrive?.tree?.actor,
    action.redrive?.uncleanTree === true || pr.evidence.rearm === true
      ? String(pr.evidence.driverActor)
      : null,
    String(pr.evidence.driverClone),
  );
  if (opening.missingOriginal && "waits" in opening && pr.evidence.rearm)
    failedRearmRequest(report, repo.slug, pr, opening.waits);
  const opened = await openedFor(
    state,
    action,
    slots,
    Promise.resolve(opening),
  );
  if ("outcome" in opened) return opened.outcome;
  const { workspace } = opened;
  const pastDeadline = outOfTime(state);
  if (pastDeadline !== null)
    return waits(action, pastDeadline, slots.account.name);
  const heads = await launchHeads(repo.slug, pr, undefined, timeLeftMs(state));
  const moved = await requestMovedSince(action, pr, drive);
  if (moved !== null) return waits(action, moved);
  const result = await startCheckedRecovery(
    state,
    action,
    driveRecord(state, repo, action, pr, slots, workspace, id, named, heads),
    slots,
    drive.claimer,
  );
  if (pr.evidence.rearm === true) await consumeLaunched(state, result, drive);
  return result;
}

/** Why a rearm request's pull request changed between the plan's read and the launch; `null` when it did not, or for any other launch. */
async function requestMovedSince(
  action: Action,
  pr: DrivenPr,
  drive: FreshDrive,
): Promise<string | null> {
  if (action.steward !== undefined || pr.evidence.rearm !== true) return null;
  const again = await drive.read(pr.number);
  if (!again.ok) return again.failure.reason;
  return stillWanted(action, again.value, drive.held);
}

/** Acknowledges the request a launch carried out, once the launch started. */
async function consumeLaunched(
  state: ApplyState,
  result: LaunchOutcome,
  drive: FreshDrive,
): Promise<void> {
  if (result.outcome !== "launched" && result.outcome !== "retried") return;
  const record = state.records.find(
    (r) => r.record.id === result.record,
  )?.record;
  if (record !== undefined) await consumeRequest(state, record, result, drive);
}

/** `--apply` for one repository's drives; `fresh` re-reads one pull request's ledger and labels. */
export async function applyDrives(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  fresh: FreshDrive,
): Promise<void> {
  await retryRequests(state, repo, report, fresh);
  await retryPending(state, repo, report, fresh);
  const rearms = report.actions.filter((a) => a.stage === "rearm");
  for (const action of rotated(state, rearms, "targets")) {
    const late = outOfTime(state);
    if (late !== null) {
      report.launches.push(waits(action, late));
      continue;
    }
    const pr = Number(action.target.replace(/^PR #/, ""));
    let read: Outcome<DrivenPr | null>;
    try {
      read = await fresh.read(pr, action.steward !== undefined);
    } catch (error) {
      report.launches.push(
        waits(action, `its ledger cannot be read again: ${failureText(error)}`),
      );
      continue;
    }
    if (!read.ok) {
      report.launches.push(
        waits(
          action,
          `its ledger cannot be read again: ${read.failure.reason}`,
        ),
      );
      continue;
    }
    const result = await launchOne(
      state,
      repo,
      action,
      stewardFresh(
        read.value,
        action,
        read.value !== null && fresh.held(read.value),
      ),
      sessions,
      fresh,
      report,
    );
    report.launches.push(result);
    if (
      action.steward &&
      result.record !== null &&
      ["launched", "retried", "lost"].includes(result.outcome)
    )
      markStewardEffect(action.steward.id, result.record, state.root);
  }
}

/** A failed label removal never grants another launch; retry only its acknowledgment. */
async function retryRequests(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  fresh: FreshDrive,
): Promise<void> {
  if (fresh.labelWrites === false) return;
  for (const { record, state: launchState } of state.records) {
    if (record.repo !== repo.slug || !pendingRearm(record, launchState))
      continue;
    const result = waits(
      { target: `PR #${record.pr}`, stage: "rearm" } as Action,
      "waiting to acknowledge the accepted rearm request",
      record.account,
    );
    const late = outOfTime(state);
    if (late !== null) {
      result.detail += `: ${late}`;
      report.launches.push(result);
      continue;
    }
    const consumed = await acknowledgeRequest(state, record, fresh);
    if (!consumed.ok) {
      result.detail += `: ${consumed.failure.reason}`;
      report.launches.push(result);
    }
  }
}
