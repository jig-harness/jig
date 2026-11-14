/** The owner host schedules an admitted, bounded pass; the pass has no launch authority. */
import { parseRoutingModels } from "../../../skills/do-item/scripts/lib/routing.ts";
import { runtimeModel } from "../../../shared/model-families.ts";
import { admittedVendor, codexLaunchFields } from "../accounts.ts";
import { factsOf } from "./drive-hold.ts";
import { readFailures } from "../failures.ts";
import {
  holds,
  type LaunchRecord,
  newRecordId,
  newToken,
  targetOf,
} from "../launches.ts";
import { loadReport } from "../load.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { questionOf, sessionIdFor } from "../session.ts";
import { stateDb } from "../state.ts";
import { dispatched } from "../runtime/port.ts";
import {
  digestHash,
  keepStewardRun,
  STEWARD_DEADLINE_SEC,
  stewardDue,
  stewardRuns,
  stewardWaits,
  type StewardDigest,
} from "../steward.ts";
import type { PoolIssue } from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { RepoObservation, Tracked } from "../tick-observe.ts";
import type { Action } from "../types.ts";
import {
  admitAccount,
  type ApplyState,
  openedFor,
  openWithinBudget,
  startRecord,
  waits,
  replayable,
  replay,
  accountBlocked,
  readRoomMs,
} from "./launch.ts";

export async function applySteward(
  state: ApplyState,
  observation: RepoObservation,
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
  for (const record of replayable(state, repo.slug, ["steward"])) {
    const action: Action = {
      stage: "steward",
      target: "the steward",
      record: "runtime",
      reason: "retry the pending steward launch under its existing token",
      evidence: {},
    };
    report.launches.push(
      await replay(state, record, action, await accountBlocked(state, record)),
    );
  }
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
  if (
    stewardRuns(null, state.root).filter((r) => r.at > Date.now() - 3_600_000)
      .length >= 3
  )
    return skip("the host's hourly steward budget is spent");
  const runs = stewardRuns(repo.slug, state.root);
  if (stewardWaits(runs, Date.now(), config.everyMs))
    return skip("cadence has not elapsed or hourly budget is spent");
  const read = await readDigest(state, observation);
  if (!read.ok) return skip(read.failure.reason);
  const digest = read.value;
  const hash = digestHash(digest);
  if (!stewardDue(hash, runs, Date.now(), config.everyMs))
    return skip("input is unchanged since the last pass");
  const action: Action = {
    stage: "steward",
    target: "the steward",
    record: "runtime",
    reason: "changed work needs the steward's judgment",
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
  const id = newRecordId(new Date());
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
    createdAt: new Date().toISOString(),
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
  keepStewardRun(id, digest, Date.now(), state.root);
  report.launches.push(await startRecord(state, record, slots));
  report.steward = { status: "pass recorded and launch attempted", hash };
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
): Promise<Outcome<StewardDigest, QueueFailure>> {
  const { opened, tracked, forge } = observation;
  const { repo, report } = opened;
  const read = await stewardQueue(tracked, () => readRoomMs(state));
  if (!read.ok) return read;
  const queue = read.value;
  return ok({
    version: 1,
    repo: repo.slug,
    drives: forge.drives.map((pr) => ({
      ...pr,
      evidence: { ...pr.evidence, stewardFacts: factsOf(pr) },
    })),
    needs: report.actions.filter((a) => a.stage === "notify"),
    queue,
    passes: state.records.flatMap((r) =>
      r.record.repo === repo.slug &&
      (r.record.action === "pickup" || r.record.action === "followup") &&
      r.state.kind === "ended"
        ? [
            {
              record: r.record.id,
              action: r.record.action,
              target: targetOf(r.record),
              question: questionOf(r.state),
              said: r.state.exit.context ?? r.state.exit.said ?? null,
            },
          ]
        : [],
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
