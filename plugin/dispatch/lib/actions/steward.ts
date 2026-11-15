/** The owner host schedules an admitted, bounded pass; the pass has no launch authority. */
import { parseRoutingModels } from "../../../skills/do-item/scripts/lib/routing.ts";
import { runtimeModel } from "../../../shared/model-families.ts";
import { admittedVendor, codexLaunchFields } from "../accounts.ts";
import { factsOf } from "./drive-hold.ts";
import { readFailures } from "../failures.ts";
import {
  holds,
  type LaunchRecord,
  type ReadRecord,
  newRecordId,
  newToken,
  targetOf,
} from "../launches.ts";
import { loadReport } from "../load.ts";
import { durableSummary, passOutput } from "../pass-output.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { questionIn, sessionIdFor } from "../session.ts";
import { stateDb } from "../state.ts";
import { dispatched } from "../runtime/port.ts";
import {
  collectStewardEvidence,
  STEWARD_HISTORY_TARGET_LIMIT,
} from "../steward-evidence.ts";
import {
  backlogHash,
  forgetStewardRun,
  judgedResumes,
  keepStewardRun,
  STEWARD_DEADLINE_SEC,
  stewardBudgetSpent,
  stewardRuns,
  type StewardDigest,
} from "../steward.ts";
import {
  type Backlog,
  type BacklogInput,
  judgedMembers,
  stewardBacklog,
  stewardTrigger,
  type StewardTrigger,
} from "../steward-backlog.ts";
import { parkClassesOf } from "../steward-resume.ts";
import type { StationContext } from "../line-station.ts";
import { parseTrackerLabels } from "../../../shared/tracker-labels.ts";
import type { PoolIssue } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { RepoObservation, Tracked } from "../tick-observe.ts";
import type { Action, LaunchOutcome, RepoReport } from "../types.ts";
import {
  admitAccount,
  type ApplyState,
  openedFor,
  openWithinBudget,
  startRecord,
  waits,
  replayable,
  replay,
  accountBlock,
  readRoomMs,
} from "./launch.ts";
import { currentIso, currentMs } from "../../../shared/time.ts";

/**
 * Start the steward when the judgment backlog holds a member no earlier pass
 * saw: at once, within the host's hourly budget, while no other pass holds
 * the repository. An empty or already judged backlog starts nothing, and the
 * receipt says which.
 */
export async function applySteward(
  state: ApplyState,
  observation: RepoObservation,
  station: StationContext,
  readDigest: typeof digestOf = digestOf,
): Promise<void> {
  const { opened, forge } = observation;
  const { repo, report } = opened;
  const config = state.machine.steward;
  const skip = (status: string) => {
    report.steward = { status };
  };
  if (!opened.owner) return skip("another host owns this repository");
  if (!opened.stages.has("steward") || !config?.enabled)
    return skip("steward is disabled on this host");
  await replayPending(state, repo.slug, report);
  if (
    state.records.some(
      (r) =>
        r.record.repo === repo.slug &&
        r.record.action === "steward" &&
        holds(r.state),
    )
  )
    return skip("a steward pass already holds this repository");
  if (!forge.ok || report.records.some((r) => !r.ok))
    return skip("the digest's records did not all read");
  const found = await backlogOf(state, observation, station);
  if (!found.ok) return skip(found.failure.reason);
  const backlog = found.value;
  const trigger = stewardTrigger(
    backlog.members,
    judgedMembers(repo.slug, state.root),
  );
  if (trigger.kind !== "due") {
    report.steward = notStarted(trigger);
    return;
  }
  if (stewardBudgetSpent(stewardRuns(null, state.root), currentMs())) {
    report.steward = {
      status: "the host's hourly steward budget is spent",
      trigger: "budget",
    };
    return;
  }
  const read = await readDigest(state, observation, backlog);
  if (!read.ok) return skip(read.failure.reason);
  const digest = read.value;
  const hash = backlogHash(backlog.members);
  const action: Action = {
    stage: "steward",
    target: "the steward",
    record: "runtime",
    reason: `${trigger.unjudged} of the judgment backlog's ${trigger.members} members wait on the steward's judgment`,
    evidence: { hash },
  };
  const admitted = await admitAccount(
    state,
    repo.slug,
    action,
    STEWARD_DEADLINE_SEC,
  );
  if ("outcome" in admitted) {
    report.launches.push(admitted.outcome);
    return skip(admitted.outcome.detail);
  }
  const { slots } = admitted;
  const id = newRecordId();
  const named = dispatched("steward", "line", id);
  const openedWorkspace = await openedFor(
    state,
    action,
    slots,
    openWithinBudget(
      state,
      repo,
      { notices: "jig-dispatch-steward", dispatched: named },
      false,
      false,
    ),
  );
  if ("outcome" in openedWorkspace) {
    report.launches.push(openedWorkspace.outcome);
    return skip(openedWorkspace.outcome.detail);
  }
  const vendor = admittedVendor(slots.account);
  const runtime = vendor === "claude" ? "claude-code" : "codex";
  const models = parseRoutingModels(opened.values);
  const family = models[runtime]?.complex;
  if (family === undefined) {
    report.launches.push(
      waits(action, "the complex tier has no model for the admitted runtime"),
    );
    return;
  }
  const record: LaunchRecord = {
    version: 1,
    id,
    token: newToken(),
    action: "steward",
    repo: repo.slug,
    repoPath: repo.path,
    pr: null,
    item: null,
    account: slots.account.name,
    vendor,
    configDir: slots.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    passTimeoutSec: STEWARD_DEADLINE_SEC,
    ...codexLaunchFields(state.codexOptIn),
    replaces: null,
    facts: hash,
    createdAt: currentIso(),
    workspace: openedWorkspace.workspace,
    attempts: [],
    agentId: null,
    model: runtimeModel(runtime, family),
    effort: null,
    released: false,
    command: null,
    marker: null,
    headless: true,
    sessionId: sessionIdFor(vendor),
    mark: named.mark,
  };
  const launch = await startKept(state, record, slots, digest);
  report.launches.push(launch);
  report.steward = stewardStatus(
    launch,
    state.records.some((r) => r.record.id === record.id),
    trigger,
    hash,
  );
}

/**
 * What the launch left: a run taken back started nothing, a record still
 * pending awaits a retry (the answer was lost, so a pass may or may not run),
 * and only a launch the runtime accepted is a start.
 */
function stewardStatus(
  launch: LaunchOutcome,
  kept: boolean,
  trigger: Extract<StewardTrigger, { kind: "due" }>,
  hash: string,
): NonNullable<RepoReport["steward"]> {
  if (!kept) return { status: `not started: ${launch.detail}`, hash };
  if (launch.outcome !== "launched" && launch.outcome !== "retried")
    return {
      status: `launch pending, a later tick retries it: ${launch.detail}`,
      hash,
    };
  return {
    status: `started for ${trigger.unjudged} unjudged of ${trigger.members} in the judgment backlog`,
    hash,
    trigger: "started",
  };
}

/** Retry each pending steward launch under its token; one the runtime refused started no pass, so its run is taken back. */
async function replayPending(
  state: ApplyState,
  slug: string,
  report: RepoReport,
): Promise<void> {
  for (const record of replayable(state, slug, ["steward"])) {
    const action: Action = {
      stage: "steward",
      target: "the steward",
      record: "runtime",
      reason: "retry the pending steward launch under its existing token",
      evidence: {},
    };
    report.launches.push(
      await replay(state, record, action, await accountBlock(state, record)),
    );
    if (!state.records.some((r) => r.record.id === record.id))
      forgetStewardRun(record.id, state.root);
  }
}

/** The judgment backlog, derived from the whole queue: a queued item the tick did not read is read now. */
async function backlogOf(
  state: ApplyState,
  observation: RepoObservation,
  station: StationContext,
): Promise<Outcome<Backlog, QueueFailure>> {
  const queued = await stewardQueue(observation.tracked, () =>
    readRoomMs(state),
  );
  if (!queued.ok) return queued;
  return ok(
    stewardBacklog(backlogInput(state, observation, station, queued.value)),
  );
}

/**
 * Keep the run, then start its pass. A launch that threw or left no record
 * behind started no pass, so nobody judged its members: the run is taken back.
 */
export async function startKept(
  state: ApplyState,
  record: LaunchRecord,
  slots: Parameters<typeof startRecord>[2],
  digest: StewardDigest,
  start: typeof startRecord = startRecord,
): Promise<LaunchOutcome> {
  keepStewardRun(record.id, digest, currentMs(), state.root);
  try {
    const launch = await start(state, record, slots);
    if (!state.records.some((r) => r.record.id === record.id))
      forgetStewardRun(record.id, state.root);
    return launch;
  } catch (error) {
    forgetStewardRun(record.id, state.root);
    throw error;
  }
}

/** Why a backlog that is not due starts no pass, as the receipt and the dashboard say it. */
function notStarted(
  trigger: Exclude<StewardTrigger, { kind: "due" }>,
): NonNullable<RepoReport["steward"]> {
  return trigger.kind === "empty"
    ? { status: "the judgment backlog is empty", trigger: "empty" }
    : {
        status: `every member of the judgment backlog (${trigger.members}) was already judged`,
        trigger: "judged",
      };
}

/** The facts the tick already read that the judgment backlog is derived from. */
function backlogInput(
  state: ApplyState,
  observation: RepoObservation,
  station: StationContext,
  queue: PoolIssue[],
): BacklogInput {
  const { opened, forge } = observation;
  const labels = parseTrackerLabels(opened.values);
  return {
    slug: opened.repo.slug,
    actions: opened.report.actions,
    running: opened.report.running,
    drives: forge.drives,
    held: observation.held,
    queue,
    records: state.records,
    parkClasses: parkClassesOf(opened.values),
    labels: { hitl: labels.hitl, manualOps: labels.manualOps },
    station,
  };
}

/** Why the steward's queue could not be completed this tick. */
type QueueFailure = "out-of-time" | "unread";

/** The longest one queued item's read may take. */
const QUEUE_READ_MS = 60_000;

/**
 * Reuse the tick's evidence and keep the digest separate from launch
 * admission. A digest that cannot be completed is a failure, since a
 * partial queue would hash as changed input.
 */
async function digestOf(
  state: ApplyState,
  observation: RepoObservation,
  backlog: Backlog,
): Promise<Outcome<StewardDigest, QueueFailure>> {
  const { opened, tracked, forge } = observation;
  const { repo } = opened;
  const read = await stewardQueue(tracked, () => readRoomMs(state));
  if (!read.ok) return read;
  const queue = read.value;
  const targets = await collectStewardEvidence(
    state.records,
    observation,
    queue,
    () => readRoomMs(state),
  );
  return ok({
    version: 1,
    repo: repo.slug,
    backlog: backlog.members,
    drives: forge.drives.map((pr) => ({
      ...pr,
      evidence: { ...pr.evidence, stewardFacts: factsOf(pr) },
    })),
    needs: backlog.needs,
    framed: backlog.framed,
    queue,
    targets,
    targetHistoryLimit: STEWARD_HISTORY_TARGET_LIMIT,
    passes: stewardPasses(
      state.records,
      repo.slug,
      judgedResumes(repo.slug, state.root),
    ),
    failures: readFailures(repo.slug, state.root),
    load: state.load === undefined ? null : loadReport(state.load),
    history: (
      stateDb(state.root)
        .query(
          "SELECT row FROM log WHERE repo = ? AND stage != 'steward' ORDER BY seq DESC LIMIT 50",
        )
        .all(repo.slug) as Array<{ row: string }>
    ).map((r) => JSON.parse(r.row)),
  });
}

/**
 * The steward's queue: a queued item the observe phase already read is not
 * read again, and the rest are read one at a time within `room`, what the
 * tick has left before its launch (`null` for a tick that keeps no start).
 * A queue that time ran out on, or whose read failed, is a failure.
 */
export async function stewardQueue(
  tracked: Pick<Tracked, "pickups" | "tracker">,
  room: () => number | null,
): Promise<Outcome<PoolIssue[], QueueFailure>> {
  const queue: PoolIssue[] = [];
  for (const item of tracked.pickups) {
    if (item.queueIssue !== undefined) {
      queue.push(item.queueIssue);
      continue;
    }
    if (tracked.tracker === null) continue;
    const left = room();
    if (left !== null && left <= 0)
      return failed(
        "out-of-time",
        "the tick deadline has no room for the steward's queue reads",
      );
    const issue = await tracked.tracker
      .poolIssue(
        item.key,
        AbortSignal.timeout(Math.min(QUEUE_READ_MS, left ?? QUEUE_READ_MS)),
      )
      .then(
        (read) => ({ read }),
        () => null,
      );
    if (issue === null)
      return failed(
        "unread",
        `the queued item ${item.key} did not read for the steward's digest`,
      );
    if (issue.read !== null) queue.push(issue.read);
  }
  return ok(queue);
}

/** The durable summary of a pass's output, or `null` when it kept none. */
function keptSummary(context: string | undefined): string | null {
  const summary = durableSummary(context ?? "");
  return summary === "" ? null : summary;
}

/**
 * Question context remains separate from each target's latest output. A pass
 * that framed a decision is a person's, and a pass whose resume the tick
 * already judged (`judged`) is settled: neither is offered for a resume.
 */
export function stewardPasses(
  records: ReadRecord[],
  slug: string,
  judged: ReadonlySet<string> = new Set(),
): StewardDigest["passes"] {
  return records.flatMap((r) => {
    if (r.record.repo !== slug || r.state.kind !== "ended") return [];
    if (r.framed || judged.has(r.record.id)) return [];
    if (r.record.action !== "pickup" && r.record.action !== "followup")
      return [];
    const { exit } = r.state;
    const kept = passOutput(
      { output: exit.context || exit.said || "", said: exit.said ?? "" },
      null,
      r.record.token ?? "",
    );
    const asked = questionIn(kept.said ?? "");
    const question = asked === null ? null : durableSummary(asked);
    return [
      {
        record: r.record.id,
        action: r.record.action,
        target: targetOf(r.record),
        question,
        said: asked === null ? null : keptSummary(kept.context),
      },
    ];
  });
}
