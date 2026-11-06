/**
 * One repository's turn in a tick, as its phases in order: open the
 * repository, observe it (tick-observe.ts), plan wanted minus running
 * (tick-plan.ts), give the records that ended their outcome rows
 * (tick-settle.ts), act with `--apply` (tick-apply.ts), project the labels
 * (tick-labels.ts), and report the shared records' reads and writes
 * (tick-shared.ts). Each phase hands the next what it read; the report is
 * filled as they go.
 */
import { actObserved } from "./tick-apply.ts";
import { allRecords, type TickContext } from "./tick-context.ts";
import { projectObserved } from "./tick-labels.ts";
import { lineInputOf } from "./tick-line.ts";
import { observeRepo, openRepo } from "./tick-observe.ts";
import { planObserved } from "./tick-plan.ts";
import { logRepo } from "./tick-settle.ts";
import { sharedReport } from "./tick-shared.ts";
import type { RepoReport } from "./types.ts";

/** One repository's turn: its report, the one that refuses it when it does not open. */
export async function gatherRepo(
  path: string,
  context: TickContext,
): Promise<RepoReport> {
  const opened = await openRepo(path, context);
  if (!("repo" in opened)) return opened;
  const observation = await observeRepo(opened, {
    options: context.options,
    runtime: context.runtime,
    nowMs: context.nowMs,
    records: allRecords(context),
  });
  const { report } = opened;
  const { forge, tracked, sessions } = observation;
  planObserved(context, observation);
  await logRepo(context, opened.repo.slug, report, forge.drives);
  await actObserved(context, observation);
  await projectObserved(context, observation);
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
  return report;
}
