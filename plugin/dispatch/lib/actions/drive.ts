/**
 * `--apply` for drives: start each re-arm and takeover the plan wants, in
 * order, as a headless pass in the pull request's workspace, on an
 * admitted account. For each one:
 *
 * 1. read the pull request's ledger again, and go on only when its facts
 *    are the ones the plan acted on;
 * 2. admit an account (accounts.ts), and check that the wrapper's
 *    environment resolves to that account's identity;
 * 3. use the workspace that holds the pull request, or open one;
 * 4. write the launch record, then call the runtime's `launch` under the
 *    record's token (launch.ts).
 *
 * Before any of that, a pending record of the repository whose launch got
 * no answer is retried once, under its own record and token, never as a
 * fresh launch. Everything else in the plan is reported, as without
 * `--apply`.
 */
import { type LaunchRecord, newRecordId, newToken } from "../launches.ts";
import type { SessionsReport } from "../runtime/port.ts";
import { failureText } from "../text.ts";
import type {
  Action,
  DrivenPr,
  LaunchOutcome,
  RepoReport,
  RepoTarget,
} from "../types.ts";
import { factsOf } from "./drive-hold.ts";
import {
  accountBlocked,
  admitAccount,
  type ApplyState,
  changedWhileOpening,
  type Opened,
  openWithinBudget,
  outOfTime,
  replay,
  replayable,
  rotated,
  startRecord,
  waits,
  workspaceOr,
} from "./launch.ts";

export type { ApplyState } from "./launch.ts";

/** Retry, once and under its own key, each pending record of `repo` whose launch got no answer. */
async function retryPending(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  fresh: (pr: number) => Promise<DrivenPr | null>,
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
  fresh: (pr: number) => Promise<DrivenPr | null>,
): Promise<string | null> {
  let read: DrivenPr | null;
  try {
    read = await fresh(record.pr as number);
  } catch (error) {
    return `its ledger cannot be read again: ${failureText(error)}`;
  }
  if (read === null) return "its ledger cannot be read again";
  if (record.facts !== factsOf(read))
    return `its ledger changed since the launch (now ${factsOf(read)})`;
  const want = record.action === "rearm" ? "re-armable" : "silent";
  if (read.class !== want) return `its ledger now reads ${read.class}`;
  return accountBlocked(state, record);
}

/** The fresh read: the ledger must still say what the plan acted on. */
function stillWanted(action: Action, fresh: DrivenPr | null): string | null {
  if (fresh === null) return "its ledger cannot be read again";
  if (factsOf(fresh) !== action.facts)
    return `its ledger changed since the plan read it (now ${factsOf(fresh)})`;
  const want = action.takeover === undefined ? "re-armable" : "silent";
  return fresh.class === want
    ? null
    : `its ledger now reads ${fresh.class}: ${fresh.why}`;
}

async function workspaceFor(
  state: ApplyState,
  repo: RepoTarget,
  pr: number,
  head: string,
  sessions: SessionsReport,
): Promise<Opened> {
  const held = sessions.ok
    ? sessions.workspaces.find((w) => w.prs.includes(pr))
    : undefined;
  if (held !== undefined)
    return { workspace: { id: held.id, path: held.path } };
  return openWithinBudget(state, repo, { pr, head });
}

/** One planned re-arm or takeover, through its fresh read, admission, workspace and launch. */
async function launchOne(
  state: ApplyState,
  repo: RepoTarget,
  action: Action,
  fresh: DrivenPr | null,
  sessions: SessionsReport,
): Promise<LaunchOutcome> {
  const late = outOfTime(state);
  if (late !== null) return waits(action, late);
  const changed = stillWanted(action, fresh);
  if (changed !== null) return waits(action, changed);
  const admitted = await admitAccount(state, action);
  if ("outcome" in admitted) return admitted.outcome;
  const slots = admitted.slots;
  const pr = fresh as DrivenPr;
  const opened = workspaceOr(
    action,
    await workspaceFor(state, repo, pr.number, pr.head, sessions),
    slots.account.name,
  );
  if ("outcome" in opened) return opened.outcome;
  const { workspace } = opened;
  const stale = await changedWhileOpening(state, action, slots);
  if (stale !== null) return stale;
  const pastDeadline = outOfTime(state);
  if (pastDeadline !== null)
    return waits(action, pastDeadline, slots.account.name);
  return startRecord(
    state,
    {
      version: 1,
      id: newRecordId(new Date()),
      token: newToken(),
      action: action.takeover === undefined ? "rearm" : "takeover",
      repo: repo.slug,
      repoPath: repo.path,
      pr: pr.number,
      account: slots.account.name,
      vendor: slots.account.vendor,
      configDir: slots.account.configDir,
      wallBackoffMs: state.machine.wallBackoffMs,
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
    },
    slots,
  );
}

/** `--apply` for one repository's drives; `fresh` re-reads one pull request's ledger. */
export async function applyDrives(
  state: ApplyState,
  repo: RepoTarget,
  report: RepoReport,
  sessions: SessionsReport,
  fresh: (pr: number) => Promise<DrivenPr | null>,
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
      read = await fresh(pr);
    } catch (error) {
      report.launches.push(
        waits(action, `its ledger cannot be read again: ${failureText(error)}`),
      );
      continue;
    }
    report.launches.push(await launchOne(state, repo, action, read, sessions));
  }
}
