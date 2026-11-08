/**
 * The label projection, last in a repository's turn: each managed pull
 * request's state label set from its ledger (actions/labels.ts). The labels
 * are the owner's to write, as its board, notifications and history rows
 * are, and only with `--apply` for a repository the machine file lists.
 * Each write is counted in the failure ledger (failures.ts): one that keeps
 * failing backs off, and a pull request whose labels no longer need a write
 * drops its row.
 */
import { outOfTime } from "./actions/launch.ts";
import {
  labelKey,
  planLabels,
  type ProjectionInput,
  writeLabels,
} from "./actions/labels.ts";
import type { LabelConfig } from "./labels.ts";
import { bookOf, type TickContext } from "./tick-context.ts";
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
  if (!forge.ok) return;
  const apply = context.apply;
  const book = bookOf(context, slug, report);
  if (labels === null) {
    book?.wanted("label", []);
    return;
  }
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
  planned.report.held = report.labels?.held ?? [];
  const writing = apply !== null && forge.listed;
  book?.wanted(
    "label",
    writing ? planned.changes.map((c) => labelKey(c.pr)) : [],
  );
  planned.report.writes = await writeLabels(slug, planned.changes, {
    apply: writing,
    late: () => (apply === null ? null : outOfTime(apply)),
    book,
  });
  report.labels = planned.report;
}
