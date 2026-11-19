/**
 * One repository's turn in a tick, in two parts. Its observe part, run
 * beside every other repository's: open the repository and observe it
 * (tick-observe.ts). Its act part, run in turn under the act lock: plan
 * wanted minus running (tick-plan.ts), give the records that ended their
 * outcome rows (tick-settle.ts), act with `--apply` (tick-apply.ts),
 * project the labels (tick-labels.ts), and report the shared records' reads
 * and writes (tick-shared.ts). Each phase hands the next what it read; the
 * report is filled as they go, and each phase's milliseconds are kept on it
 * (`phasesMs`). Applying ticks reconcile abandoned local ledgers before
 * planning; that reconciliation time is charged to apply.
 *
 * Each part is run inside the tick's boundary: what throws out of it is a
 * defect (`defectReport`), which stops this repository's turn only. The
 * report keeps what the phases before it did, launches included. Inside
 * `--apply`, each stage is a boundary of its own (`stageDefect`): a defect
 * in one stops that stage only, and the turn's other stages still run.
 */
import { defectOf, logDefect, logStageDefect } from "./defect.ts";
import { PhaseTimer } from "./phase-timer.ts";
import { actObserved } from "./tick-apply.ts";
import {
  allRecords,
  emptyReport,
  tickBound,
  type TickContext,
} from "./tick-context.ts";
import { projectObserved } from "./tick-labels.ts";
import { lineInputOf } from "./tick-line.ts";
import { finalParkLedgers } from "./final-park-ledgers.ts";
import { branchPattern } from "./section.ts";
import {
  type OpenedRepo,
  observeRepo,
  openRepo,
  type RepoObservation,
} from "./tick-observe.ts";
import { observeReleaseTags } from "./release-gates.ts";
import { rereadPendingArms } from "./arm-reread.ts";
import { releaseStationOn } from "./release-handoff.ts";
import {
  adoptReleaseHandoffs,
  releaseNeedActions,
  releaseNeeds,
  tagPrefixOf,
} from "./release-needs.ts";
import { readFailureOf } from "./read-failures.ts";
import { planObserved } from "./tick-plan.ts";
import { logRepo } from "./tick-settle.ts";
import { sharedReport } from "./tick-shared.ts";
import { recoverLedgers } from "./recover-ledgers.ts";
import type { ApplyStage, RepoPhase, RepoReport } from "./types.ts";

/** One repository's turn as it runs: its phases' clock, and its report once the repository opened. */
export interface RepoTurn {
  path: string;
  timer: PhaseTimer<RepoPhase>;
  report: RepoReport | null;
}

export function startTurn(path: string): RepoTurn {
  return { path, timer: new PhaseTimer(), report: null };
}

/** A repository's observe part done: what it read, for its act part; or the report that ends its turn. */
export type Observed =
  | { turn: RepoTurn; opened: OpenedRepo; observation: RepoObservation }
  | { report: RepoReport }
  | { busy: string };

/** What `claim` answers when the lock was waited for: another tick may have acted, so the open read is stale. */
export const REOPEN = Symbol("reopen");

/** How many times one turn opens again after a lock wait: each reopen can name a new slug. */
const MAX_REOPENS = 3;

/**
 * Open one repository; the report that refuses it when it does
 * not open. `claim` takes the repository's own lock once its slug is known
 * (waiting for it, if it must) and returns who holds it when another tick does: nothing is read then.
 * It answers `REOPEN` when a wait for the lock came between the open read and
 * the lock: the repository is then opened again from refreshed facts, its
 * target and configuration included, never planned from the earlier read.
 */
export async function openTurn(
  turn: RepoTurn,
  context: TickContext,
  claim: (
    slug: string,
  ) =>
    | string
    | null
    | typeof REOPEN
    | Promise<string | null | typeof REOPEN> = () => null,
): Promise<
  | { turn: RepoTurn; opened: OpenedRepo }
  | { report: RepoReport }
  | { busy: string }
> {
  const { path, timer } = turn;
  let opened = await timer.time("open", () => openRepo(path, context));
  if (!("repo" in opened)) return { report: timed(opened, timer) };
  let heldBy = await claim(opened.repo.slug);
  // A slug already reopened for is fresh under its lock; a new slug the refresh
  // names waits and reopens in its turn, within the bound.
  const refreshed = new Set<string>();
  for (
    let reopens = 0;
    heldBy === REOPEN && reopens < MAX_REOPENS;
    reopens += 1
  ) {
    refreshed.add(opened.repo.slug);
    context.reads.refreshRepository(path);
    opened = await timer.time("open", () => openRepo(path, context));
    if (!("repo" in opened)) return { report: timed(opened, timer) };
    heldBy = await claim(opened.repo.slug);
    if (heldBy === REOPEN && refreshed.has(opened.repo.slug)) heldBy = null;
  }
  // Out of reopens with the last read still stale: the turn waits for the next tick.
  if (heldBy === REOPEN)
    return {
      busy: "its repository lock was waited for again after the last reopen",
    };
  if (heldBy !== null) return { busy: heldBy };
  turn.report = opened.report;
  const { owner, reflection } = opened;
  context.reflections.push({ slug: opened.repo.slug, path, reflection, owner });
  return { turn, opened };
}

/** Derive one repository's work after the tick has gathered its tracker scopes. */
export async function observeOpenedTurn(
  prepared: { turn: RepoTurn; opened: OpenedRepo },
  context: TickContext,
): Promise<Observed> {
  const { turn, opened } = prepared;
  const { path, timer } = turn;
  const bound = tickBound(context);
  const observation = await observeRepo(
    opened,
    {
      options: context.options,
      runtime: context.runtime,
      nowMs: context.nowMs,
      records: allRecords(context),
      reads: context.reads,
      world: context.world,
      ...(bound === undefined ? {} : { bound }),
    },
    timer,
  );
  const { forge, tracked, sessions } = observation;
  const finalParks =
    opened.owner && forge.ok
      ? await timer.time("forge", () =>
          finalParkLedgers(
            opened.repo.slug,
            forge.open,
            forge.login,
            context.reads.comments,
            opened.report,
            bound,
          ),
        )
      : [];

  if (forge.ok && opened.section.followupCommand !== null) {
    const settled = await timer.time("forge", () =>
      rereadPendingArms(
        opened.repo,
        forge.merged,
        allRecords(context),
        context.nowMs,
        bound,
      ),
    );
    if (settled.ok) observation.armsSettled = settled.value;
    else {
      const failure = readFailureOf(settled.failure);
      opened.report.records.push({
        record: "forge",
        source: `gh ${opened.repo.slug} release tags`,
        ok: false,
        detail: `The pending follow-up arms past dispatch.followup_within were not read again, so they go to a person as their passes read them: ${settled.failure.reason}`,
        ...(failure === undefined ? {} : { failure }),
      });
    }
  }
  if (releaseStationOn(opened)) {
    const tags = await timer.time("forge", () =>
      observeReleaseTags(opened.repo, context.nowMs, bound),
    );
    if (!tags.ok) {
      const failure = readFailureOf(tags.failure);
      opened.report.records.push({
        record: "forge",
        source: `gh ${opened.repo.slug} release tags`,
        ok: false,
        detail: `Keeping the previous release tag reading: ${tags.failure.reason}`,
        ...(failure === undefined ? {} : { failure }),
      });
    }
  }
  // Observations belong to the tick even when a later phase fails.
  context.lineInputs.set(path, {
    ...lineInputOf(observation.drives, forge, tracked, sessions, {
      slug: opened.repo.slug,
      branchPattern: branchPattern(opened.values),
    }),
    finalParks,
  });
  return { turn, opened, observation };
}

/** Plan, log, act on and label one observed repository, under the act lock; its report. */
export async function actTurn(
  observed: Extract<Observed, { turn: RepoTurn }>,
  context: TickContext,
): Promise<RepoReport> {
  const { turn, opened, observation } = observed;
  const { timer } = turn;
  const { report } = opened;
  if (context.apply !== null)
    await timer.time("apply", () => recoverLedgers(context, observation));
  await timer.time("plan", () => planObserved(context, observation));
  if (releaseStationOn(opened))
    await timer.time("plan", () => {
      adoptReleaseHandoffs(opened.repo.slug, observation.forge.merged);
      report.actions.push(
        ...releaseNeedActions(
          releaseNeeds(opened.repo.slug),
          tagPrefixOf(opened.values),
        ),
      );
    });
  await timer.time("log", () =>
    logRepo(context, opened.repo.slug, report, observation.drives),
  );
  // The labels are projected before the notices go out, so a failure alert is judged against the rows the projection leaves.
  const project = () =>
    timer.time("labels", () => projectObserved(context, observation));
  const close = async () => {
    if (context.apply === null) await project();
    await timer.time("shared", () => closeShared(context, observation));
    timed(report, timer);
  };
  if (context.apply === null) {
    await timer.time("apply", () => Promise.resolve());
    await close();
  } else {
    // The launches run after every repository is gathered; a defect in one stage stops that stage only.
    // Work that times its own phases (the close) runs with `inApply` false, so apply is not charged for it.
    const guard = async (
      stage: ApplyStage,
      run: () => Promise<void>,
      inApply = true,
    ) => {
      try {
        await (inApply ? timer.time("apply", run) : run());
      } catch (error) {
        stageDefect(turn, report, stage, error);
      } finally {
        // The timer adds a turn's time when the turn returns, so the receipt's copy is taken after it.
        timed(report, timer);
      }
    };
    await timer.time("apply", () =>
      actObserved(context, observation, { guard, project, after: close }),
    );
  }
  return timed(report, timer);
}

/** The shared records' report, and what the line and the tick's close read of this repository. */
function closeShared(context: TickContext, observation: RepoObservation): void {
  const { forge } = observation;
  const report = observation.opened.report;
  report.shared = sharedReport(
    observation.shared,
    observation.ctx,
    observation.claims,
    forge,
  );
  // The budget is the host's: read once, as the tick started.
  if (forge.ok) context.reads.budgets.push(report.shared);
}

/** A turn's phases in the order they start, which the report keeps whatever order overlapping phases end in. */
const REPO_PHASES: readonly RepoPhase[] = [
  "open",
  "tracker",
  "forge",
  "claims",
  "runtime",
  "observe",
  "plan",
  "log",
  "apply",
  "labels",
  "shared",
];

function timed(report: RepoReport, timer: PhaseTimer<RepoPhase>): RepoReport {
  report.phasesMs = Object.fromEntries(
    REPO_PHASES.filter((p) => timer.ms[p] !== undefined).map((p) => [
      p,
      timer.ms[p],
    ]),
  );
  return report;
}

/**
 * A defect one stage of `--apply` threw, which stops that stage only: on the
 * report beside any other stage's, in the outcome log, and on the error
 * output with its stack. The turn's other stages run as if it had not.
 */
function stageDefect(
  turn: RepoTurn,
  report: RepoReport,
  stage: ApplyStage,
  error: unknown,
): void {
  const defect = {
    ...defectOf(turn.timer.caught() ?? "apply", error, stage),
    stage,
  };
  report.stageDefects = [...(report.stageDefects ?? []), defect];
  logDefect(
    `the ${stage} stage of ${report.slug ?? turn.path}'s turn`,
    defect,
    error,
  );
  logStageDefect(report.slug ?? turn.path, defect);
}

/**
 * The report of a turn a defect stopped: what its earlier phases put on it,
 * refused with the defect; its stack goes to the error output only.
 */
export function defectReport(turn: RepoTurn, error: unknown): RepoReport {
  const defect = defectOf(turn.timer.current ?? "open", error);
  const report = turn.report ?? emptyReport(turn.path, "");
  report.refused = `a defect stopped this repository's turn, and nothing after it was done this tick: ${defect.reason}`;
  report.defect = defect;
  logDefect(`${report.slug ?? turn.path}'s turn`, defect, error);
  return timed(report, turn.timer);
}
