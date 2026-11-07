/**
 * The act phase of one repository's turn, with `--apply` only: this host's
 * own launch claims whose records ended get their end, then the launch
 * stages the machine file enables for the repository run in this tick's
 * rotated order (actions/drive.ts, actions/pickup.ts, actions/followup.ts),
 * then its nudges (actions/steer.ts) and its notifications
 * (actions/notify.ts). Each launch reads its target again just before it
 * starts. The apply state these change as they go, the slot table, the
 * records and the deadline, is built here once per tick.
 */
import type { Contention } from "./contention.ts";
import { passTimeoutSeconds } from "../../skills/drive-pr/scripts/lib/driver/settings.ts";
import { hostCodexOptIn, lastAccount, slotTable } from "./accounts.ts";
import {
  type ApplyState,
  applyDrives,
  type FreshDrive,
} from "./actions/drive.ts";
import { applyFollowups } from "./actions/followup.ts";
import { applyNotices } from "./actions/notify.ts";
import { applyPickups } from "./actions/pickup.ts";
import { applySteers } from "./actions/steer.ts";
import { adoptionOf } from "./adopt.ts";
import { type LaunchGroup, launchStageOrder } from "./apply-order.ts";
import { readOutcomes } from "./followup-outcomes.ts";
import { openPullRequest, pullRequestLabels } from "./forge.ts";
import { carriesSet, hasCommand } from "./labels.ts";
import { nextTickIndex } from "../receipts.ts";
import type { ReadRecord } from "./launches.ts";
import type {
  JoinTargets,
  SessionRuntime,
  SessionsReport,
} from "./runtime/port.ts";
import { launchClaimer, type SharedContext } from "./shared-launches.ts";
import { readDrives } from "./sources/ledgers.ts";
import {
  allRecords,
  type TickContext,
  type TickOptions,
} from "./tick-context.ts";
import {
  readSessions,
  type RepoObservation,
  type Tracked,
} from "./tick-observe.ts";
import { afterWait } from "./tick-plan.ts";
import { endOwnClaims } from "./tick-shared.ts";
import type {
  DispatchSection,
  MarkedPr,
  RepoReport,
  RepoTarget,
} from "./types.ts";

/**
 * The apply state of a tick run with `--apply` and a machine file; why it was
 * withheld when no slot can be told free or the rotation cannot be kept;
 * `null` for a report.
 */
export function applyState(
  options: TickOptions,
  runtime: SessionRuntime,
  records: ReadRecord[],
  nowMs: number,
  unreadable: string[],
  startedAt: number,
): ApplyState | { withheld: string } | null {
  const machine = options.machine ?? null;
  if (!options.apply || machine === null) return null;
  // A record that cannot be read may belong to a live wrapper, so its slot and
  // pull request cannot be told apart from a free one: launch nothing.
  if (unreadable.length > 0)
    return {
      withheld: `${unreadable.length} launch record(s) do not read, so no slot can be told free`,
    };
  // A rotation cursor that cannot be recorded would repeat: launch nothing.
  const tick = nextTickIndex();
  if (typeof tick !== "number")
    return { withheld: `the rotation cursor cannot be kept: ${tick.failed}` };
  return {
    machine,
    runtime,
    records,
    table: slotTable(machine.accounts, records, nowMs),
    last: lastAccount(records),
    passDeadlineSec: passTimeoutSeconds(),
    codexOptIn: hostCodexOptIn(),
    startedAt,
    tick,
    repos: options.repos.length,
  };
}

/**
 * Act on one observed and planned repository; nothing without `--apply`.
 * Its own claims end now; its launches and notifications are handed to
 * `context.pending`, run in turns once every repository is gathered, and
 * `after` runs when its last turn is done; `guard` bounds each of them.
 */
export async function actObserved(
  context: TickContext,
  observation: RepoObservation,
  hooks: {
    guard: (run: () => Promise<void>, inApply?: boolean) => Promise<void>;
    after: () => Promise<void>;
  },
): Promise<void> {
  const apply = context.apply;
  if (apply === null) return;
  const { opened, forge, ctx, claims } = observation;
  const { repo, section, report } = opened;
  await endOwnClaims(ctx, report, {
    claims,
    forge,
    records: allRecords(context),
    outcomes: readOutcomes(repo.slug),
    nowMs: context.nowMs,
  });
  const inputs: ApplyInputs = {
    repo,
    runtime: context.runtime,
    section,
    tracked: observation.tracked,
    login: forge.login,
    merged: forge.merged,
    join: observation.join,
    sessions: observation.sessions,
    shared: ctx,
    unplaced: withheldFromReplay(afterWait(context, observation.serialized)),
  };
  context.pending.push({
    apply: (group) =>
      hooks.guard(() =>
        applyStages(apply, opened.stages, report, inputs, group),
      ),
    finish: () =>
      hooks
        .guard(() =>
          applyStages(apply, opened.stages, report, inputs, "finish"),
        )
        // `after` times its own phases; the same exception boundary, outside the apply timer.
        .then(() => hooks.guard(hooks.after, false)),
  });
}

/** The pull requests no pending launch of theirs is replayed for: those whose place cannot be told, and those held behind another member of their group. */
export function withheldFromReplay(
  serialized: Pick<Contention, "held" | "unplaced">,
): ReadonlyMap<number, string> {
  const out = new Map(serialized.unplaced);
  for (const [pr, { area, leader }] of serialized.held)
    if (!out.has(pr)) out.set(pr, `held in ${area} behind PR #${leader}`);
  return out;
}

/** What `--apply` acts on for one repository, as its tick read it. */
interface ApplyInputs {
  repo: RepoTarget;
  runtime: SessionRuntime;
  section: DispatchSection;
  tracked: Tracked;
  login: string | null;
  merged: MarkedPr[];
  join: JoinTargets;
  sessions: SessionsReport;
  shared: SharedContext;
  /** Pull requests whose place in a serialized group this tick cannot tell, by number and why. */
  unplaced: ReadonlyMap<number, string>;
}

/**
 * `--apply` for one repository: the launch stages its machine-file entry
 * enables, in this tick's turn, then its notifications, which open no
 * session and so share no turn.
 */
async function applyStages(
  apply: ApplyState,
  enabled: ReadonlySet<string>,
  report: RepoReport,
  inputs: ApplyInputs,
  group: LaunchGroup | "finish",
): Promise<void> {
  const { repo, runtime, section, tracked, login, join } = inputs;
  const fresh = () => readSessions(runtime, repo, join);
  const labels = section.labels.enabled ? section.labels : null;
  const drive: FreshDrive = {
    read: async (pr) => {
      // The pull request read again too: a stale drive's head and mergeability are its facts, and a hold label may have appeared.
      const listed = await openPullRequest(repo.slug, pr, {
        labels: labels !== null,
      });
      if (
        labels?.onlyLabeled === true &&
        !carriesSet(labels, listed.labels ?? [])
      )
        return null;
      const [again] = await readDrives(
        repo.slug,
        login,
        [listed],
        Date.now(),
        labels,
        adoptionOf(section, login),
      );
      return again ?? null;
    },
    held: (pr) => labels !== null && hasCommand(labels, pr.labels, "hold"),
    claimer: launchClaimer(inputs.shared),
    unplaced: inputs.unplaced,
  };
  const stages = [
    async () => {
      if (enabled.has("rearm"))
        await applyDrives(apply, repo, report, inputs.sessions, drive);
    },
    async () => {
      const { tracker, keys } = tracked;
      if (enabled.has("pickup") && tracker !== null && keys)
        await applyPickups(apply, repo, report, {
          section,
          tracker,
          keys,
          branchPattern: join.branchPattern,
          sessions: fresh,
        });
    },
    async () => {
      if (enabled.has("followup"))
        await applyFollowups(apply, repo, report, {
          section,
          login,
          merged: inputs.merged,
          sessions: fresh,
          shared: inputs.shared,
          ...(labels === null
            ? {}
            : {
                holdReason: async (pr: number) => {
                  const now = await pullRequestLabels(repo.slug, pr);
                  if (hasCommand(labels, now, "hold"))
                    return "a person's hold label is on it now";
                  return labels.onlyLabeled && !carriesSet(labels, now)
                    ? "it carries no dispatch label now"
                    : null;
                },
              }),
        });
    },
  ];
  for (const stage of launchStageOrder(
    stages,
    group,
    apply.tick ?? 0,
    apply.repos ?? 1,
  ))
    await stage();
  if (group !== "finish") return;
  // The nudges first: a nudge that went unanswered is notified in the same tick.
  if (enabled.has("steer")) await applySteers(apply, repo.slug, report);
  // A host that does not own the repository never notifies for it: the owner does, once.
  if (enabled.has("notify") && inputs.shared.owner)
    await applyNotices(apply, repo, report, inputs.sessions, {
      lingerMs: section.noticesLingerMs,
      renotifyAfterMs: section.renotifyAfterMs,
      branch: section.noticesBranch,
    });
}
