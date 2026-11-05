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
 * 3. use the workspace that holds the pull request, or open one named for
 *    the stage and the pull request (`dispatched` in `runtime/port.ts`),
 *    under the launch record's id minted here;
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
 * fresh launch. Everything else in the plan is reported, as without
 * `--apply`.
 */
import { admittedVendor } from "../accounts.ts";
import {
  type LaunchRecord,
  newRecordId,
  newToken,
  redrivenChanges,
} from "../launches.ts";
import {
  type Dispatched,
  dispatched,
  type SessionsReport,
} from "../runtime/port.ts";
import { failureText } from "../text.ts";
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
import {
  accountBlocked,
  admitAccount,
  type ApplyState,
  dropPendingRecord,
  isTakeover,
  type LaunchClaimer,
  type Opened,
  openedFor,
  openWithinBudget,
  outOfTime,
  replay,
  replayable,
  rotated,
  startRecord,
  waits,
} from "./launch.ts";

export type { ApplyState } from "./launch.ts";

/** A fresh read of one pull request's drive, whether a person's `hold` label is on it, and how a launch claims it where another host reads it. */
export interface FreshDrive {
  read: (pr: number) => Promise<DrivenPr | null>;
  held: (pr: DrivenPr) => boolean;
  claimer?: LaunchClaimer;
}

const HELD = "a person's hold label is on it now";

/** Retry, once and under its own key, each pending record of `repo` whose launch got no answer. */
async function retryPending(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  fresh: FreshDrive,
): Promise<void> {
  for (const record of replayable(state, repo.slug, ["rearm", "takeover"])) {
    const action = { target: `PR #${record.pr}`, stage: "rearm" } as Action;
    const blocked =
      (await retryBlocked(state, record, fresh)) ??
      (await unclaimed(state, record, fresh.claimer));
    report.launches.push(await replay(state, record, action, blocked));
  }
}

/**
 * A pending record's claim is checked where another host reads it before
 * every replay: a record never launched (a tick stopped between writing it
 * and its launch) may never have been claimed, and one that was launched
 * without an answer may have lost its claim since, to another host's or to a
 * person's deletion. It claims now, which is a no-op while its own claim
 * holds the launch, and a claim refused gives the record back. Why it must
 * not be replayed; `null` when it may.
 */
async function unclaimed(
  state: ApplyState,
  record: LaunchRecord,
  claimer: LaunchClaimer | undefined,
): Promise<string | null> {
  if (claimer === undefined) return null;
  const taken = await claimer.claim(record, true);
  if (!("refused" in taken)) return null;
  const why = `its launch is not claimed where another host reads it: ${taken.refused}`;
  if (taken.uncertain === true) return `${why}; the record is kept`;
  return dropPendingRecord(state, record)
    ? `${why}; the record is given back`
    : `${why}; the record is kept, since its launch started meanwhile`;
}

/** Why a pending record's launch must not be replayed now; `null` when it may. */
async function retryBlocked(
  state: ApplyState,
  record: LaunchRecord,
  fresh: FreshDrive,
): Promise<string | null> {
  let read: DrivenPr | null;
  try {
    read = await fresh.read(record.pr as number);
  } catch (error) {
    return `its ledger cannot be read again: ${failureText(error)}`;
  }
  if (read === null) return "its ledger cannot be read again";
  if (fresh.held(read)) return HELD;
  if (record.facts !== factsOf(read))
    return `its ledger changed since the launch (now ${factsOf(read)})`;
  const want = wantedClass(
    record.action === "takeover",
    record.redrive,
    record.facts,
  );
  if (read.class !== want) return `its ledger now reads ${read.class}`;
  // A stop on a conflict stands whatever moved since: its base moves often, and
  // this record holds the pull request until its launch is replayed. The replay
  // then acts on the change read now, so the record names that one, and keeps
  // the one an earlier launch may already have acted on.
  const blocked =
    record.redrive?.conflictStop === true
      ? replayedChange(state, record, read)
      : changedStale(record.redrive, read);
  if (blocked !== null) return blocked;
  return accountBlocked(state, record);
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
  if (factsOf(fresh) !== action.facts)
    return `its ledger changed since the plan read it (now ${factsOf(fresh)})`;
  const want = wantedClass(isTakeover(action), action.redrive, action.facts);
  if (fresh.class !== want)
    return `its ledger now reads ${fresh.class}: ${fresh.why}`;
  return changedStale(action.redrive, fresh);
}

async function workspaceFor(
  state: ApplyState,
  repo: RepoTarget,
  pr: number,
  head: string,
  sessions: SessionsReport,
  named: Dispatched,
): Promise<Opened> {
  const held = sessions.ok
    ? sessions.workspaces.find((w) => w.prs.includes(pr))
    : undefined;
  if (held !== undefined)
    return { workspace: { id: held.id, path: held.path } };
  return openWithinBudget(state, repo, { pr, head, dispatched: named });
}

/** The ledger's round, which the launch's outcome row counts its rounds from; `null` when the ledger does not say. */
function roundOf(pr: DrivenPr): number | null {
  const round = pr.evidence.round;
  return typeof round === "number" ? round : null;
}

/** One planned re-arm or takeover, through its fresh read, admission, workspace, shared claim and launch. */
async function launchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  fresh: DrivenPr | null,
  sessions: SessionsReport,
  drive: FreshDrive,
): Promise<LaunchOutcome> {
  const late = outOfTime(state);
  if (late !== null) return waits(action, late);
  const changed = stillWanted(action, fresh, drive.held);
  if (changed !== null) return waits(action, changed);
  const admitted = await admitAccount(state, action);
  if ("outcome" in admitted) return admitted.outcome;
  const slots = admitted.slots;
  const pr = fresh as DrivenPr;
  const id = newRecordId(new Date());
  const kind = isTakeover(action) ? "takeover" : "rearm";
  const named = dispatched(kind, `#${pr.number}`, id);
  const opened = await openedFor(
    state,
    action,
    slots,
    workspaceFor(state, repo, pr.number, pr.head, sessions, named),
  );
  if ("outcome" in opened) return opened.outcome;
  const { workspace } = opened;
  const pastDeadline = outOfTime(state);
  if (pastDeadline !== null)
    return waits(action, pastDeadline, slots.account.name);
  return startRecord(
    state,
    {
      version: 1,
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
      codexBypass: state.codexOptIn.on,
      replaces: action.takeover ?? null,
      facts: action.facts ?? factsOf(pr),
      createdAt: new Date().toISOString(),
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
      mark: named.mark,
    },
    slots,
    drive.claimer,
  );
}

/** `--apply` for one repository's drives; `fresh` re-reads one pull request's ledger and labels. */
export async function applyDrives(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  fresh: FreshDrive,
): Promise<void> {
  await retryPending(state, repo, report, fresh);
  const rearms = report.actions.filter((a) => a.stage === "rearm");
  for (const action of rotated(state, rearms, "targets")) {
    const late = outOfTime(state);
    if (late !== null) {
      report.launches.push(waits(action, late));
      continue;
    }
    const pr = Number(action.target.replace(/^PR #/, ""));
    let read: DrivenPr | null;
    try {
      read = await fresh.read(pr);
    } catch (error) {
      report.launches.push(
        waits(action, `its ledger cannot be read again: ${failureText(error)}`),
      );
      continue;
    }
    report.launches.push(
      await launchOne(state, repo, action, read, sessions, fresh),
    );
  }
}
