/**
 * The label projection, last in a repository's turn: each managed pull
 * request's state label set from its ledger (actions/labels.ts). The labels
 * are the owner's to write, as its board, notifications and history rows
 * are, and only with `--apply` for a repository the machine file lists.
 */
import { outOfTime } from "./actions/launch.ts";
import {
  planLabels,
  type ProjectionInput,
  writeLabels,
} from "./actions/labels.ts";
import type { LabelConfig } from "./labels.ts";
import type { TickContext } from "./tick-context.ts";
import type { ForgeRead } from "./tick-forge.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { RepoReport } from "./types.ts";

/** Project the labels of one observed repository. */
export async function projectObserved(
  context: TickContext,
  observation: RepoObservation,
): Promise<void> {
  const { opened, labels, forge, ctx, serialized } = observation;
  await projectLabels(context, opened.repo.slug, opened.report, labels, {
    ...forge,
    listed: opened.listed && ctx.owner,
    serialized,
  });
}

/**
 * The projection, last in a repository's tick: each managed pull request's
 * state label set from its ledger, written only with `--apply` for a
 * repository the machine file lists, and only where its labels disagree.
 * Nothing where the labels are off, or the pull requests did not read.
 */
async function projectLabels(
  context: TickContext,
  slug: string,
  report: RepoReport,
  labels: LabelConfig | null,
  forge: ForgeRead & {
    listed: boolean;
    serialized: NonNullable<ProjectionInput["serialized"]>;
  },
): Promise<void> {
  if (labels === null || !forge.ok) return;
  const followedUp = new Set(
    report.quiet
      .filter((q) => q.class === "followup-done")
      .map((q) => Number(q.target.replace(/^PR #/, ""))),
  );
  const planned = planLabels({
    config: labels,
    open: forge.open.filter((p) => !forge.disputed.has(p.number)),
    read: forge.read,
    drives: forge.drives,
    merged: forge.merged.filter((p) => !forge.disputed.has(p.number)),
    followedUp,
    serialized: forge.serialized,
  });
  const apply = context.apply;
  planned.report.held = report.labels?.held ?? [];
  planned.report.writes = await writeLabels(slug, planned.changes, {
    apply: apply !== null && forge.listed,
    late: () => (apply === null ? null : outOfTime(apply)),
  });
  report.labels = planned.report;
}
