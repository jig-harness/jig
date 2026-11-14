/** A once-only continuation, with the same current-authority checks on initial launch and replay. */
import { DEFAULT_PARK_CLASSES } from "../../shared/autonomy.ts";
import { parseTrackerLabels } from "../../shared/tracker-labels.ts";
import { admittedVendor } from "./accounts.ts";
import {
  accountBlocked,
  admitAccount,
  dropRecord,
  holdRecord,
  launchHeld,
  replay,
  startRecord,
  type ApplyState,
} from "./actions/launch.ts";
import { laneCapWait } from "./actions/followup-lane.ts";
import { claim as claimFollowupRecord } from "./actions/followup.ts";
import { readMarkers } from "./followup-marker.ts";
import { pullRequestLabels } from "./forge.ts";
import { holding } from "./holding.ts";
import { hasCommand } from "./labels.ts";
import {
  holds,
  newRecordId,
  newToken,
  targetOf,
  type LaunchRecord,
  type ReadRecord,
} from "./launches.ts";
import { localRecoverySpent } from "./no-cause-stops.ts";
import { RECOVERY_FACTS } from "./recovery-facts.ts";
import { routineEnd } from "./routine-reruns.ts";
import { waitEnd } from "./followup-waits.ts";
import {
  dispatched,
  marksIn,
  type SessionsReport,
  type Workspace,
} from "./runtime/port.ts";
import { questionOf, sessionIdFor } from "./session.ts";
import {
  routineRecommendation,
  resumablePickup,
} from "./steward-resume-policy.ts";
import {
  claimStewardRecord,
  markStewardEffect,
  stewardRecords,
  type StewardRecord,
} from "./steward.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { Action } from "./types.ts";
import { failureText } from "./text.ts";
import { currentIso, currentMs } from "../../shared/time.ts";

interface Source {
  record: LaunchRecord & {
    action: "pickup" | "followup";
    workspace: { id: string; path: string };
  };
  question: string;
  output: string;
}
type ResumeDecision = Extract<StewardRecord, { kind: "resume" }>;

function unavailable(
  observation: RepoObservation,
  target: string,
  reason: string,
): void {
  observation.opened.report.unplaced.push({
    record: "runtime",
    target,
    reason,
  });
}

function sourceOf(
  state: ApplyState,
  observation: RepoObservation,
  decision: ResumeDecision,
): Source | null {
  const old = state.records.find(
    (r) =>
      r.record.id === decision.record &&
      r.record.repo === observation.opened.repo.slug,
  );
  if (
    old?.state.kind !== "ended" ||
    old.record.stewardResume !== undefined ||
    old.result === "done" ||
    !old.record.workspace
  )
    return null;
  if (old.record.action !== "pickup" && old.record.action !== "followup")
    return null;
  if (!eligiblePass(old)) return null;
  const question = questionOf(old.state);
  const output = old.state.exit.context ?? old.state.exit.said ?? "";
  const policy = observation.opened.values.autonomy as
    | { park_classes?: string[] }
    | undefined;
  if (
    question === null ||
    routineRecommendation(
      question,
      output,
      policy?.park_classes ?? DEFAULT_PARK_CLASSES,
    ) === null
  )
    return null;
  return {
    record: {
      ...old.record,
      action: old.record.action,
      workspace: old.record.workspace,
    },
    question,
    output,
  };
}

function eligiblePass(old: ReadRecord): boolean {
  if (old.record.action === "pickup") return old.record.headless === true;
  return !routineEnd(old) && !waitEnd(old);
}

function sameTarget(old: Source["record"], pending: LaunchRecord): boolean {
  return (
    pending.repo === old.repo &&
    pending.action === old.action &&
    pending.item === old.item &&
    pending.pr === old.pr &&
    pending.workspace?.id === old.workspace.id &&
    pending.workspace.path === old.workspace.path &&
    JSON.stringify(pending.batchItems) === JSON.stringify(old.batchItems)
  );
}

function competed(
  state: ApplyState,
  old: Source["record"],
  pending?: LaunchRecord,
): boolean {
  return state.records.some(
    (r) =>
      r.record.repo === old.repo &&
      r.record.id !== old.id &&
      r.record.id !== pending?.id &&
      (r.record.stewardResume === old.id ||
        (targetOf(r.record) === targetOf(old) && holds(r.state))),
  );
}

function witnessOf(
  state: ApplyState,
  observation: RepoObservation,
  id: number,
  source: Source,
  pending?: LaunchRecord,
): boolean {
  const previous = stewardRecords(source.record.repo, state.root).some(
    (r) =>
      r.id !== id &&
      r.applied &&
      r.value.kind === "resume" &&
      r.value.record === source.record.id,
  );
  if (previous || competed(state, source.record, pending)) return false;
  if (pending && !sameTarget(source.record, pending)) return false;
  return !observation.forge.drives.some(
    (p) =>
      targetOf(source.record) === `PR #${p.number}` &&
      (["parked", "stopped-by-person"].includes(p.class) ||
        observation.held.has(p.number)),
  );
}

async function markerAvailable(
  observation: RepoObservation,
  source: Source,
  pending?: LaunchRecord,
): Promise<boolean> {
  const old = source.record;
  if (old.pr === null) return true;
  const labels = await pullRequestLabels(old.repo, old.pr);
  if (!labels.ok) {
    unavailable(observation, targetOf(old), labels.failure.reason);
    return false;
  }
  if (hasCommand(observation.opened.section.labels, labels.value, "hold"))
    return false;
  const markers = await readMarkers(observation.ctx.records, old.repo, old.pr);
  if (!Array.isArray(markers)) {
    unavailable(observation, targetOf(old), markers.unreadable);
    return false;
  }
  const first = markers.filter((m) => m.trusted).sort((a, b) => a.id - b.id)[0];
  if (first?.run.kind !== "tick") return false;
  const expected = pending?.marker == null ? old : pending;
  return (
    first.id === expected.marker &&
    first.run.record === expected.id &&
    first.run.outcome !== "done" &&
    (first.run.host === undefined || first.run.host === observation.ctx.host)
  );
}

function itemsOf(source: Source, observation: RepoObservation) {
  return (
    source.record.batchItems ??
    (source.record.item === null
      ? []
      : [
          {
            key: source.record.item,
            person:
              source.record.servedPerson ?? observation.opened.section.identity,
          },
        ])
  );
}

function boundWorkspace(
  workspace: Workspace,
  old: Source["record"],
  pending?: LaunchRecord,
): boolean {
  if (
    workspace.id !== old.workspace.id ||
    workspace.path !== old.workspace.path
  )
    return false;
  const marked = marksIn(workspace.comment).some(
    (m) =>
      m.line === old.mark || (pending?.mark != null && m.line === pending.mark),
  );
  const joined =
    old.item !== null
      ? workspace.items.includes(old.item)
      : old.pr !== null && workspace.prs.includes(old.pr);
  return marked && joined;
}

async function sessionsAvailable(
  state: ApplyState,
  observation: RepoObservation,
  source: Source,
  pending?: LaunchRecord,
): Promise<SessionsReport | null> {
  const sessions = await state.runtime.sessions(
    observation.opened.repo,
    observation.join,
  );
  if (!sessions.ok) {
    unavailable(observation, targetOf(source.record), sessions.reason);
    return null;
  }
  const items = itemsOf(source, observation);
  const old = source.record;
  const holdsTarget = holding(
    sessions,
    (w) =>
      w.id === old.workspace.id ||
      items.some((i) => w.items.includes(i.key)) ||
      (old.pr !== null && w.prs.includes(old.pr)),
  );
  if (holdsTarget.kind !== "free") return null;
  if (!sessions.workspaces.some((w) => boundWorkspace(w, old, pending)))
    return null;
  const reserved =
    pending === undefined
      ? state
      : {
          ...state,
          records: state.records.filter((r) => r.record.id !== pending.id),
        };
  if (
    old.action === "followup" &&
    laneCapWait(reserved, sessions, old.repo) !== null
  )
    return null;
  return sessions;
}

async function assignmentsAvailable(
  observation: RepoObservation,
  source: Source,
): Promise<boolean> {
  if (source.record.item === null) return true;
  const tracker = observation.tracked.tracker;
  if (tracker === null) return false;
  const labels = parseTrackerLabels(observation.opened.values);
  try {
    for (const item of itemsOf(source, observation)) {
      const current = await tracker.poolIssue(
        item.key,
        AbortSignal.timeout(60_000),
      );
      if (
        !resumablePickup(current, {
          hitl: labels.hitl,
          manualOps: labels.manualOps,
        }) ||
        !current?.assignee
      )
        return false;
      if (
        !item.person ||
        current.assignee.id !== (await tracker.user(item.person)).id
      )
        return false;
    }
    return true;
  } catch (error) {
    unavailable(
      observation,
      targetOf(source.record),
      `the resume's assignments could not be read: ${failureText(error)}`,
    );
    return false;
  }
}

async function available(
  state: ApplyState,
  observation: RepoObservation,
  source: Source,
  pending?: LaunchRecord,
): Promise<boolean> {
  if (!observation.opened.stages.has(source.record.action)) return false;
  if (
    source.record.action === "followup" &&
    source.record.command !== observation.opened.section.followupCommand
  )
    return false;
  if (!(await markerAvailable(observation, source, pending))) return false;
  if ((await sessionsAvailable(state, observation, source, pending)) === null)
    return false;
  if (!(await assignmentsAvailable(observation, source))) return false;
  const records =
    pending === undefined
      ? state.records
      : state.records.filter((r) => r.record.id !== pending.id);
  return (
    source.record.pr === null ||
    localRecoverySpent(
      source.record.repo,
      source.record.pr,
      records,
      currentMs(),
    ) === null
  );
}

async function claimFollowup(
  state: ApplyState,
  observation: RepoObservation,
  record: LaunchRecord,
): Promise<string | null> {
  if (record.pr === null) return "the follow-up has no pull request";
  return claimFollowupRecord(
    state,
    observation.opened.repo,
    {
      section: observation.opened.section,
      login: observation.forge.login,
      merged: observation.forge.merged,
      sessions: () =>
        state.runtime.sessions(observation.opened.repo, observation.join),
      shared: observation.ctx,
    },
    record as LaunchRecord & { pr: number },
  );
}

async function releaseMarker(
  observation: RepoObservation,
  record: LaunchRecord,
  marker: number,
): Promise<boolean> {
  if (record.pr === null) return false;
  const released = await observation.ctx.records.release(
    { repo: record.repo, pr: record.pr },
    marker,
  );
  if (!released.ok)
    unavailable(observation, targetOf(record), released.failure.reason);
  return released.ok;
}

async function replayResume(
  state: ApplyState,
  observation: RepoObservation,
  source: Source,
  pending: LaunchRecord,
  action: Action,
): Promise<void> {
  if (
    pending.stewardContext !== `${source.output}\nQuestion: ${source.question}`
  )
    return;
  const blocked = await accountBlocked(state, pending);
  if (blocked !== null) {
    observation.opened.report.launches.push(
      await replay(state, pending, action, blocked),
    );
    return;
  }
  if (
    pending.action === "followup" &&
    pending.marker === null &&
    source.record.marker !== null
  ) {
    if (!(await releaseMarker(observation, pending, source.record.marker)))
      return;
    const why = await claimFollowup(state, observation, pending);
    if (why !== null) {
      unavailable(observation, targetOf(pending), why);
      return;
    }
  }
  observation.opened.report.launches.push(
    await replay(state, pending, action, null),
  );
}

function resumeRecord(
  source: Source,
  slots: import("./accounts.ts").Slots,
): LaunchRecord {
  const vendor = admittedVendor(slots.account);
  const id = newRecordId();
  const record: LaunchRecord = {
    ...source.record,
    id,
    token: newToken(),
    account: slots.account.name,
    vendor,
    configDir: slots.account.configDir,
    createdAt: currentIso(),
    facts: `${RECOVERY_FACTS}steward resume ${source.record.id}`,
    attempts: [],
    agentId: null,
    released: false,
    noReplay: null,
    stewardResume: source.record.id,
    stewardContext: `${source.output}\nQuestion: ${source.question}`,
    sessionId: sessionIdFor(vendor),
    mark: dispatched(
      source.record.action,
      targetOf(source.record).replaceAll(" ", ""),
      id,
    ).mark,
  };
  delete record.endedAt;
  delete record.cancelledAt;
  return record;
}

async function startFollowup(
  state: ApplyState,
  observation: RepoObservation,
  source: Source,
  record: LaunchRecord,
  slots: import("./accounts.ts").Slots,
): Promise<void> {
  holdRecord(state, record, slots);
  if (
    source.record.marker === null ||
    !(await releaseMarker(observation, record, source.record.marker))
  ) {
    dropRecord(state, record);
    return;
  }
  record.marker = null;
  const why = await claimFollowup(state, observation, record);
  if (why !== null) {
    unavailable(observation, targetOf(record), why);
    return;
  }
  observation.opened.report.launches.push(await launchHeld(state, record));
}

async function startResume(
  state: ApplyState,
  observation: RepoObservation,
  id: number,
  source: Source,
  action: Action,
): Promise<void> {
  const admitted = await admitAccount(
    state,
    source.record.repo,
    action,
    source.record.passTimeoutSec ?? 900,
  );
  if ("outcome" in admitted) {
    observation.opened.report.launches.push(admitted.outcome);
    return;
  }
  if (!claimStewardRecord(id, state.root)) return;
  const record = resumeRecord(source, admitted.slots);
  markStewardEffect(id, record.id, state.root);
  if (record.action === "followup")
    return startFollowup(state, observation, source, record, admitted.slots);
  observation.opened.report.launches.push(
    await startRecord(state, record, admitted.slots),
  );
}

export async function resumeSteward(
  state: ApplyState,
  observation: RepoObservation,
  id: number,
  decision: ResumeDecision,
  pending?: LaunchRecord,
): Promise<void> {
  const source = sourceOf(state, observation, decision);
  if (source === null || !witnessOf(state, observation, id, source, pending))
    return;
  if (!(await available(state, observation, source, pending))) return;
  const action: Action = {
    stage: source.record.action,
    target: targetOf(source.record),
    record: "runtime",
    reason: decision.reason,
    evidence: {},
  };
  if (pending) return replayResume(state, observation, source, pending, action);
  return startResume(state, observation, id, source, action);
}
