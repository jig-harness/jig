/**
 * One repository's turn in a tick, as its phases in order: open the
 * repository, observe it (tick-observe.ts), plan wanted minus running
 * (tick-plan.ts), give the records that ended their outcome rows
 * (tick-settle.ts), act with `--apply` (tick-apply.ts), project the labels
 * (tick-labels.ts), and report the shared records' reads and writes
 * (tick-shared.ts). Each phase hands the next what it read; the report is
 * filled as they go, and each phase's milliseconds are kept on it
 * (`phasesMs`).
 *
 * A turn is run inside the tick's boundary: what throws out of it is a
 * defect (`defectReport`), which stops this repository's turn only. The
 * report keeps what the phases before it did, launches included.
 */
import { defectOf, logDefect } from "./defect.ts";
import { PhaseTimer } from "./phase-timer.ts";
import { actObserved } from "./tick-apply.ts";
import { allRecords, emptyReport, type TickContext } from "./tick-context.ts";
import { projectObserved } from "./tick-labels.ts";
import { lineInputOf } from "./tick-line.ts";
import { observeRepo, openRepo } from "./tick-observe.ts";
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

/** Run one repository's turn; its report, the one that refuses it when it does not open. */
export async function runTurn(
  turn: RepoTurn,
  context: TickContext,
): Promise<RepoReport> {
  const { path, timer } = turn;
  const opened = await timer.time("open", () => openRepo(path, context));
  if (!("repo" in opened)) return timed(opened, timer);
  const { report, owner, reflection } = opened;
  turn.report = report;
  context.reflections.push({ slug: opened.repo.slug, path, reflection, owner });
  const observation = await observeRepo(
    opened,
    {
      options: context.options,
      runtime: context.runtime,
      nowMs: context.nowMs,
      records: allRecords(context),
    },
    timer,
  );
  const { forge, tracked, sessions } = observation;
  await timer.time("plan", () => planObserved(context, observation));
  await timer.time("log", () =>
    logRepo(context, opened.repo.slug, report, forge.drives),
  );
  await timer.time("apply", () => actObserved(context, observation));
  await timer.time("labels", () => projectObserved(context, observation));
  await timer.time("shared", async () => {
    report.shared = await sharedReport(
      observation.shared,
      observation.ctx,
      observation.claims,
      forge,
    );
    context.lineInputs.set(
      path,
      lineInputOf(forge.drives, forge, tracked, sessions),
    );
  });
  return timed(report, timer);
}

function timed(report: RepoReport, timer: PhaseTimer<RepoPhase>): RepoReport {
  report.phasesMs = { ...timer.ms };
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
