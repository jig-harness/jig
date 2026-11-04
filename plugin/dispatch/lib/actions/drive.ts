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
 * 4. write the launch record, then call the runtime's `launch` under the
 *    record's token (launch.ts).
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

/** A fresh read of one pull request's drive, and whether a person's `hold` label is on it. */
export interface FreshDrive {
  read: (pr: number) => Promise<DrivenPr | null>;
  held: (pr: DrivenPr) => boolean;
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
    const blocked = await retryBlocked(state, record, fresh);
    report.launches.push(await replay(state, record, action, blocked));
  }
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
  const want = wantedClass(
    action.takeover !== undefined,
    action.redrive,
    action.facts,
  );
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

/** One planned re-arm or takeover, through its fresh read, admission, workspace and launch. */
async function launchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  fresh: DrivenPr | null,
  sessions: SessionsReport,
  held: FreshDrive["held"],
): Promise<LaunchOutcome> {
  const late = outOfTime(state);
  if (late !== null) return waits(action, late);
  const changed = stillWanted(action, fresh, held);
  if (changed !== null) return waits(action, changed);
  const admitted = await admitAccount(state, action);
  if ("outcome" in admitted) return admitted.outcome;
  const slots = admitted.slots;
  const pr = fresh as DrivenPr;
  const id = newRecordId(new Date());
  const kind = action.takeover === undefined ? "rearm" : "takeover";
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
      await launchOne(state, repo, action, read, sessions, fresh.held),
    );
  }
}
