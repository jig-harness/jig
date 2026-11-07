/**
 * One repository's turn in a tick, in two parts. Its observe part, run
 * beside every other repository's: open the repository and observe it
 * (tick-observe.ts). Its act part, run in turn under the act lock: plan
 * wanted minus running (tick-plan.ts), give the records that ended their
 * outcome rows (tick-settle.ts), act with `--apply` (tick-apply.ts),
 * project the labels (tick-labels.ts), and report the shared records' reads
 * and writes (tick-shared.ts). Each phase hands the next what it read; the
 * report is filled as they go, and each phase's milliseconds are kept on it
 * (`phasesMs`).
 *
 * Each part is run inside the tick's boundary: what throws out of it is a
 * defect (`defectReport`), which stops this repository's turn only. The
 * report keeps what the phases before it did, launches included.
 */
import { defectOf, logDefect } from "./defect.ts";
import { PhaseTimer } from "./phase-timer.ts";
import { actObserved } from "./tick-apply.ts";
import { allRecords, emptyReport, type TickContext } from "./tick-context.ts";
import { projectObserved } from "./tick-labels.ts";
import { lineInputOf } from "./tick-line.ts";
import {
  type OpenedRepo,
  observeRepo,
  openRepo,
  type RepoObservation,
} from "./tick-observe.ts";
import { planObserved } from "./tick-plan.ts";
import { logRepo } from "./tick-settle.ts";
import { sharedReport } from "./tick-shared.ts";
import type { RepoPhase, RepoReport } from "./types.ts";

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
  | { report: RepoReport };

/** Open and observe one repository; the report that refuses it when it does not open. */
export async function observeTurn(
  turn: RepoTurn,
  context: TickContext,
): Promise<Observed> {
  const { path, timer } = turn;
  const opened = await timer.time("open", () => openRepo(path, context));
  if (!("repo" in opened)) return { report: timed(opened, timer) };
  turn.report = opened.report;
  const { owner, reflection } = opened;
  context.reflections.push({ slug: opened.repo.slug, path, reflection, owner });
  const observation = await observeRepo(
    opened,
    {
      options: context.options,
      runtime: context.runtime,
      nowMs: context.nowMs,
      records: allRecords(context),
      reads: context.reads,
    },
    timer,
  );
  return { turn, opened, observation };
}

/** Plan, log, act on and label one observed repository, under the act lock; its report. */
export async function actTurn(
  observed: Extract<Observed, { turn: RepoTurn }>,
  context: TickContext,
): Promise<RepoReport> {
  const { turn, opened, observation } = observed;
  const { path, timer } = turn;
  const { report } = opened;
  const { forge, tracked, sessions } = observation;
  await timer.time("plan", () => planObserved(context, observation));
  await timer.time("log", () =>
    logRepo(context, opened.repo.slug, report, forge.drives),
  );
  await timer.time("apply", () => actObserved(context, observation));
  await timer.time("labels", () => projectObserved(context, observation));
  await timer.time("shared", async () => {
    report.shared = sharedReport(
      observation.shared,
      observation.ctx,
      observation.claims,
      forge,
    );
    // The budget is the host's: read once, as the tick started.
    if (forge.ok) context.reads.budgets.push(report.shared);
    context.lineInputs.set(
      path,
      lineInputOf(forge.drives, forge, tracked, sessions),
    );
  });
  return timed(report, timer);
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
