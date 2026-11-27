/** The owner host schedules an admitted, bounded pass; the pass has no launch authority. */
import { harnessFor } from "../../../shared/agent-harness/index.ts";
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
import { NOTICES_READ } from "../notices-read.ts";
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
  countedRuns,
  pendingStewardRequest,
  requestRow,
  STEWARD_RULES,
  type StewardRequest,
  type StewardRule,
  stewardHeld,
  takeStewardRequest,
} from "../steward-requests.ts";
import {
  type Backlog,
  type BacklogInput,
  judgedMembers,
  stewardBacklog,
  stewardTrigger,
  type StewardTrigger,
} from "../steward-backlog.ts";
import { parkClassesOf } from "../steward-resume.ts";
import { unreportedRuns } from "../steward-causes.ts";
import { refusedOrders, unshownRefusals } from "../steward-orders.ts";
import type { StationContext } from "../line-station.ts";
import { parseTrackerLabels } from "../../../shared/tracker-labels.ts";
import type { PoolIssue } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { RepoObservation } from "../tick-observe.ts";
import type { Tracked } from "../tick-tracker.ts";
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
import { currentIso, currentMs, parseMs } from "../../../shared/time.ts";

/** A refusal no pass was shown is owed one, though no backlog member stands for it. */
function triggerWithRefusals(
  base: StewardTrigger,
  owed: number,
): StewardTrigger {
  if (base.kind === "due" || owed === 0) return base;
  return {
    kind: "due",
    members: base.kind === "empty" ? 0 : base.members,
    unjudged: owed,
  };
}

function triggerReason(
  trigger: Extract<StewardTrigger, { kind: "due" }>,
): string {
  return trigger.members === 0
    ? `${trigger.unjudged} refused order(s) wait on the steward's reading`
    : `${trigger.unjudged} of the judgment backlog's ${trigger.members} members, or refused orders, wait on the steward's judgment`;
}

/**
 * Start the steward when the judgment backlog holds a member no earlier pass
 * saw, or a person requested a pass (`steward-requests.ts`): at once, within
 * the host's hourly budget, while no other pass holds the repository. An
 * empty or already judged backlog starts nothing unless a pass was
 * requested, and the receipt says which. A request either rule refuses is
 * taken with the rule named, on the receipt and in the outcome log.
 */
export async function applySteward(
  state: ApplyState,
  observation: RepoObservation,
  station: StationContext,
  readDigest: typeof digestOf = digestOf,
): Promise<void> {
  const { opened } = observation;
  const { repo, report } = opened;
  const config = state.machine.steward;
  const skip = (status: string) => {
    report.steward = { status };
  };
  const off = notRunning(opened, config);
  if (off !== null) return skip(off);
  await replayPending(state, repo.slug, report);
  const request = pendingStewardRequest(stateDb(state.root), repo.slug);
  if (request !== null && settleRequest(state, repo.slug, request, skip))
    return;
  if (!mayStart(state, observation, request)) return;
  const judged = judgedMembers(
    repo.slug,
    state.root,
    new Set(
      state.records.filter((r) => holds(r.state)).map((r) => r.record.id),
    ),
  );
  const found = await backlogOf(state, observation, station, judged);
  if (!found.ok) return skip(found.failure.reason);
  const backlog = found.value.backlog;
  const trigger = triggerWithRefusals(
    stewardTrigger(backlog.members, judged),
    unshownRefusals(
      repo.slug,
      observation.tracked.pickups,
      undefined,
      state.root,
    ),
  );
  if (trigger.kind !== "due" && request === null) {
    report.steward = notStarted(trigger);
    return;
  }
  const counts = countsOf(trigger);
  const read = await readDigest(state, observation, backlog, found.value.queue);
  if (!read.ok) return skip(read.failure.reason);
  const digest = read.value;
  const hash = backlogHash(backlog.members);
  const action: Action = {
    stage: "steward",
    target: "the steward",
    record: "runtime",
    reason: `${request === null ? "" : `${request.by} requested a steward pass; `}${trigger.kind === "due" ? triggerReason(trigger) : `${counts.unjudged} of the judgment backlog's ${counts.members} members wait on the steward's judgment`}`,
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
  const model = stewardModel(opened.values, slots.account);
  if (model === undefined) {
    report.launches.push(
      waits(action, "the complex tier has no model for the admitted runtime"),
    );
    return;
  }
  const record = stewardRecord(state, observation, {
    id,
    account: slots.account,
    vendor: model.vendor,
    model: model.model,
    facts: hash,
    workspace: openedWorkspace.workspace,
    mark: named.mark,
  });
  const launch = await startKept(state, record, slots, digest);
  report.launches.push(launch);
  const kept = state.records.some((r) => r.record.id === record.id);
  report.steward = stewardStatus(launch, kept, counts, hash, request);
  // A launch still pending may never have started a pass: the request stays
  // until the replay settles it (`answerRequest` takes it once the pass is
  // known to exist; a replay that takes the run back leaves it to start anew).
  if (kept && started(launch))
    takeRequestWith(state, repo.slug, request, record.id);
}

const started = (launch: LaunchOutcome): boolean =>
  launch.outcome === "launched" || launch.outcome === "retried";

/** Why the steward does not run on this repository at all, or `null`. */
function notRunning(
  opened: RepoObservation["opened"],
  config: ApplyState["machine"]["steward"],
): string | null {
  if (!opened.owner) return "another host owns this repository";
  if (!opened.stages.has("steward") || !config?.enabled)
    return "steward is disabled on this host";
  return null;
}

/**
 * Only a launch created after the request, and past pending or accepted by
 * the runtime, answers it (`answerRequest`); a launch still pending may belong to another trigger or
 * hold an acknowledgment nobody claimed yet, so the request waits for it.
 * Whether the request needs no further handling this tick.
 */
function settleRequest(
  state: ApplyState,
  slug: string,
  request: StewardRequest,
  skip: (status: string) => void,
): boolean {
  if (answerRequest(state, slug, request, skip)) return true;
  if (!pendingLaunch(state, slug)) return false;
  skip(
    `${request.by}'s request is kept: a pending steward launch is not settled yet`,
  );
  return true;
}

/** The vendor and complex-tier model the admitted account runs the steward on; `undefined` when the runtime has none. */
function stewardModel(
  values: RepoObservation["opened"]["values"],
  account: Parameters<typeof admittedVendor>[0],
): { vendor: ReturnType<typeof admittedVendor>; model: string } | undefined {
  const vendor = admittedVendor(account);
  const runtime = harnessFor(vendor).runtime;
  const family = parseRoutingModels(values, "steward")[runtime]?.complex;
  return family === undefined
    ? undefined
    : { vendor, model: runtimeModel(runtime, family) };
}

/** Takes the request a started pass answers, with the pass named. */
function takeRequestWith(
  state: ApplyState,
  slug: string,
  request: StewardRequest | null,
  started: string,
): void {
  if (request === null) return;
  takeStewardRequest(
    request,
    requestRow(request, slug, { started }),
    state.root,
  );
}

/**
 * A tick interrupted after it launched the pass and before it took the
 * request: the pass the request asked for already exists, so the request is
 * taken with it. Whether it was.
 */
function answerRequest(
  state: ApplyState,
  slug: string,
  request: StewardRequest,
  skip: (status: string) => void,
): boolean {
  const answered = state.records.find(
    (r) =>
      r.record.action === "steward" &&
      // A launch still pending may never have started a pass, unless the
      // runtime accepted it: a `sent` attempt is a pass that exists, whatever
      // the wrapper has claimed yet.
      (r.state.kind !== "pending" ||
        r.record.attempts.some((a) => a.outcome === "sent")) &&
      r.record.repo.toLowerCase() === request.repo &&
      parseMs(r.record.createdAt) >= parseMs(request.at),
  );
  if (answered === undefined) return false;
  takeStewardRequest(
    request,
    requestRow(request, slug, { started: answered.record.id }),
    state.root,
  );
  skip(
    `${request.by}'s request is answered by steward pass ${answered.record.id}, started since it was sent`,
  );
  return true;
}

/**
 * Whether the rules let a pass start now: no pass holds the repository, the
 * digest's records all read, and the host's hourly budget is not spent.
 * When not, the receipt says why, and a request a rule refuses is taken
 * with the rule named.
 */
function mayStart(
  state: ApplyState,
  observation: RepoObservation,
  request: StewardRequest | null,
): boolean {
  const { opened, forge } = observation;
  const { repo, report } = opened;
  if (stewardHeld(state.records, repo.slug)) {
    if (request === null) report.steward = { status: STEWARD_RULES.held };
    else refuseRequest(state, request, report, "held");
    return false;
  }
  if (!forge.ok || report.records.some((r) => !r.ok)) {
    report.steward = { status: "the digest's records did not all read" };
    return false;
  }
  const runs = countedRuns(state.records, stewardRuns(null, state.root));
  if (!stewardBudgetSpent(runs, currentMs())) return true;
  if (request === null)
    report.steward = { status: STEWARD_RULES.budget, trigger: "budget" };
  else refuseRequest(state, request, report, "budget");
  return false;
}

/** What a steward launch is started with, beside what every steward record holds. */
interface StewardLaunch {
  id: string;
  account: { name: string; configDir: string };
  vendor: LaunchRecord["vendor"];
  model: LaunchRecord["model"];
  facts: string;
  workspace: LaunchRecord["workspace"];
  mark: NonNullable<LaunchRecord["mark"]> | null;
}

/** The launch record of a headless steward pass on the repository `observation` opened. */
function stewardRecord(
  state: ApplyState,
  observation: RepoObservation,
  launch: StewardLaunch,
): LaunchRecord {
  const { repo } = observation.opened;
  return {
    version: 1,
    id: launch.id,
    token: newToken(),
    action: "steward",
    repo: repo.slug,
    repoPath: repo.path,
    pr: null,
    item: null,
    account: launch.account.name,
    vendor: launch.vendor,
    configDir: launch.account.configDir,
    wallBackoffMs: state.machine.wallBackoffMs,
    ...(state.machine.failures?.startupThreshold === undefined
      ? {}
      : { startupFailureThreshold: state.machine.failures.startupThreshold }),
    passTimeoutSec: STEWARD_DEADLINE_SEC,
    ...codexLaunchFields(state.codexOptIn),
    replaces: null,
    facts: launch.facts,
    createdAt: currentIso(),
    workspace: launch.workspace,
    attempts: [],
    agentId: null,
    model: launch.model,
    effort: null,
    released: false,
    command: null,
    marker: null,
    headless: true,
    sessionId: sessionIdFor(launch.vendor),
    mark: launch.mark,
  };
}

/** How many members the judgment backlog holds, and how many no pass has judged. */
function countsOf(trigger: StewardTrigger): BacklogCounts {
  if (trigger.kind === "due") return trigger;
  if (trigger.kind === "judged")
    return { members: trigger.members, unjudged: 0 };
  return { members: 0, unjudged: 0 };
}

type BacklogCounts = { members: number; unjudged: number };

/** Take a requested pass a rule refused, saying which on the receipt and in the outcome log. */
function refuseRequest(
  state: ApplyState,
  request: StewardRequest,
  report: RepoReport,
  rule: StewardRule,
): void {
  const reason = STEWARD_RULES[rule];
  takeStewardRequest(
    request,
    requestRow(request, report.slug ?? request.repo, { rule, reason }),
    state.root,
  );
  report.steward = {
    status: `${request.by}'s request refused: ${reason}`,
    trigger: rule,
    requestedBy: request.by,
  };
}

/**
 * What the launch left: a run taken back started nothing, a record still
 * pending awaits a retry (the answer was lost, so a pass may or may not run),
 * and only a launch the runtime accepted is a start.
 */
function stewardStatus(
  launch: LaunchOutcome,
  kept: boolean,
  counts: BacklogCounts,
  hash: string,
  request: StewardRequest | null,
): NonNullable<RepoReport["steward"]> {
  const by = request === null ? {} : { requestedBy: request.by };
  if (!kept) return { status: `not started: ${launch.detail}`, hash, ...by };
  if (launch.outcome !== "launched" && launch.outcome !== "retried")
    return {
      status: `launch pending, a later tick retries it: ${launch.detail}`,
      hash,
      ...by,
    };
  return {
    status: `started ${request === null ? "" : `on ${request.by}'s request, `}${
      counts.members === 0 && counts.unjudged > 0
        ? `for ${counts.unjudged} refused order(s) awaiting the steward's reading`
        : `for ${counts.unjudged} unjudged of ${counts.members} in the judgment backlog`
    }`,
    hash,
    trigger: "started",
    ...by,
  };
}

/** Whether a steward launch of `slug` is still pending: it may or may not have started a pass. */
function pendingLaunch(state: ApplyState, slug: string): boolean {
  return state.records.some(
    (r) =>
      r.record.action === "steward" &&
      r.record.repo.toLowerCase() === slug.toLowerCase() &&
      r.state.kind === "pending",
  );
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
    const launch = await replay(
      state,
      record,
      action,
      await accountBlock(state, record),
    );
    report.launches.push(launch);
    if (!state.records.some((r) => r.record.id === record.id))
      forgetStewardRun(record.id, state.root);
  }
}

/** The judgment backlog, derived from the whole queue: a queued item the tick did not read is read now. */
async function backlogOf(
  state: ApplyState,
  observation: RepoObservation,
  station: StationContext,
  judged: ReadonlySet<string>,
): Promise<Outcome<{ backlog: Backlog; queue: PoolIssue[] }, QueueFailure>> {
  const queued = await stewardQueue(observation.tracked, () =>
    readRoomMs(state),
  );
  if (!queued.ok) return queued;
  return ok({
    backlog: stewardBacklog(
      backlogInput(state, observation, station, queued.value, judged),
    ),
    queue: queued.value,
  });
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
  judged: ReadonlySet<string>,
): BacklogInput {
  const { opened } = observation;
  const labels = parseTrackerLabels(opened.values);
  return {
    slug: opened.repo.slug,
    actions: opened.report.actions,
    running: opened.report.running,
    drives: observation.drives,
    held: observation.held,
    queue,
    records: state.records,
    parkClasses: parkClassesOf(opened.values),
    labels: { hitl: labels.hitl, manualOps: labels.manualOps },
    station,
    judged,
    ...(state.root === undefined ? {} : { root: state.root }),
  };
}

/** Why the steward's queue could not be completed this tick. */
type QueueFailure = "out-of-time" | "unread";

/** The longest one queued item's read may take. */
const QUEUE_READ_MS = 60_000;

/**
 * Reuse the tick's evidence, the queue `backlogOf` completed included, and keep the digest separate from launch
 * admission. A digest that cannot be completed is a failure, since a
 * partial queue would hash as changed input.
 */
async function digestOf(
  state: ApplyState,
  observation: RepoObservation,
  backlog: Backlog,
  queue: PoolIssue[],
): Promise<Outcome<StewardDigest, QueueFailure>> {
  const { opened } = observation;
  const { repo } = opened;
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
    drives: observation.drives.map((pr) => ({
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
    unreported: unreportedRuns(state.records, backlog.members, state.root),
    failures: readFailures(repo.slug, state.root),
    load: state.load === undefined ? null : loadReport(state.load),
    history: stewardHistory(repo.slug, state.root),
    refused: refusedOrders(repo.slug, observation.tracked.pickups, state.root),
  });
}

/**
 * The repository's latest outcome-log rows the steward judges from: the
 * steward's own rows and the `notices_read` rows, a measure's observation
 * that lands every tick, are left out, so they never crowd out what ended.
 */
export function stewardHistory(repo: string, root?: string): unknown[] {
  return (
    stateDb(root)
      .query(
        "SELECT row FROM log WHERE repo = ? AND stage != 'steward' AND bucket != ? ORDER BY seq DESC LIMIT 50",
      )
      .all(repo, `event: ${NOTICES_READ}`) as Array<{ row: string }>
  ).map((r) => JSON.parse(r.row));
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
