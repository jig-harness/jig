/**
 * The label projection, last in a repository's turn: each managed pull
 * request's state label set from its ledger, and each pull request's marker
 * labels from its description and author (actions/labels.ts), and the items
 * each links moved to or out of `blocked` (actions/blocked.ts). The labels
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
import { writeBlocked } from "./actions/blocked.ts";
import { adoptionOf, ownAuthors } from "./adopt.ts";
import type { LabelConfig } from "./labels.ts";
import { forgeReread, ledgerStillCurrent } from "./label-freshness.ts";
import { manualOpsLabel } from "./owed-steps.ts";
import { unobservedTarget } from "./notices.ts";
import { bookOf, type TickContext } from "./tick-context.ts";
import { pullRequestHead, pullRequestLabels } from "./forge.ts";
import type { ForgeRead } from "./tick-forge.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { RepoReport } from "./types.ts";

/** Project the labels of one observed repository. */
export async function projectObserved(
  context: TickContext,
  observation: RepoObservation,
): Promise<void> {
  const { opened, labels, forge, ctx, serialized, tracked } = observation;
  await projectLabels(
    context,
    opened.repo.slug,
    opened.report,
    labels,
    {
      ...forge,
      listed: opened.listed && ctx.owner,
      serialized,
    },
    opened,
    tracked,
  );
}

/** The check before each state write: the open pull requests read for a ledger, each ledger read again (`label-freshness.ts`). */
function freshness(
  slug: string,
  forge: Pick<ForgeRead, "open" | "read" | "drives" | "login" | "merged">,
): ReturnType<typeof ledgerStillCurrent> {
  const open = forge.open.map((p) => p.number).filter((n) => forge.read.has(n));
  return ledgerStillCurrent(
    new Set(open),
    forge.drives,
    forgeReread(slug, forge.login),
    {
      read: new Map(
        forge.merged.flatMap((p) =>
          p.labels === undefined ? [] : [[p.number, p.labels] as const],
        ),
      ),
      reread: (pr) => pullRequestLabels(slug, pr),
    },
    {
      read: new Map(
        forge.open.flatMap((p) =>
          p.headRefOid === undefined ? [] : [[p.number, p.headRefOid] as const],
        ),
      ),
      reread: (pr) => pullRequestHead(slug, pr),
    },
  );
}

/** The tracker output's input: the managed open pull requests, as the labels read them, and the tracker the tick opened. */
function blockedInput(
  config: LabelConfig,
  forge: ForgeRead & {
    serialized: NonNullable<ProjectionInput["serialized"]>;
  },
  tracked: Pick<RepoObservation["tracked"], "tracker" | "keys"> | undefined,
): Parameters<typeof writeBlocked>[0] {
  return {
    config,
    tracker: tracked?.tracker ?? null,
    keys: tracked?.keys ?? null,
    open: forge.open.filter((p) => !forge.disputed.has(p.number)),
    read: forge.read,
    drives: forge.drives,
    merged: new Set(forge.merged.map((p) => p.number)),
    serialized: forge.serialized,
  };
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
  { values, section }: Pick<RepoObservation["opened"], "values" | "section">,
  tracked?: Pick<RepoObservation["tracked"], "tracker" | "keys">,
): Promise<void> {
  if (!forge.ok) return;
  const apply = context.apply;
  const book = bookOf(context, slug, report);
  if (labels === null) {
    book?.wanted("label", []);
    return;
  }
  const number = (target: string) => Number(target.replace(/^PR #/, ""));
  const followedUp = new Set(
    report.quiet
      .filter((q) => q.class === "followup-done")
      .map((q) => number(q.target)),
  );
  // A failed follow-up the tick will not start again: the plan notifies a person of it, or would, but for a hold label, which keeps the notification off and not the state.
  const followupFailed = new Set(
    [...report.actions, ...(report.labels?.held ?? [])]
      .filter((a) => a.cause === "followup-failed")
      .map((a) => number(a.target)),
  );
  // A merge whose follow-up markers do not read: where its follow-up stands is not known this tick.
  const followupUnplaced = new Set(
    report.unplaced
      .filter((u) => u.target.startsWith("PR #"))
      .map((u) => number(u.target)),
  );
  const manualOps = manualOpsLabel(values, labels.prefix);
  if (!manualOps.ok)
    report.records.push({
      record: "forge",
      source: "issue_tracker.labels.manual_ops",
      ok: false,
      detail: `the manual-operations label's name does not read, so no pull request's owed-steps label is written: ${manualOps.failure.reason}`,
    });
  const planned = planLabels({
    config: labels,
    open: forge.open.filter((p) => !forge.disputed.has(p.number)),
    read: forge.read,
    drives: forge.drives,
    merged: forge.merged.filter((p) => !forge.disputed.has(p.number)),
    followedUp,
    followupFailed,
    followupUnplaced,
    manualOps: manualOps.ok ? manualOps.value : null,
    own: ownAuthors(adoptionOf(section, forge.login), forge.login),
    serialized: forge.serialized,
  });
  planned.report.held = report.labels?.held ?? [];
  const writing = apply !== null && forge.listed;
  book?.wanted(
    "label",
    writing ? planned.changes.map((c) => labelKey(c.pr, c.part)) : [],
    // A pull request the listings disagree on is read again next tick: its write is not known to be unwanted.
    (target) =>
      unobservedTarget(report, target) ||
      [...forge.disputed].some((n) => target === `PR #${n}`),
  );
  const late = () => (apply === null ? null : outOfTime(apply));
  const current = freshness(slug, forge);
  planned.report.writes = await writeLabels(slug, planned.changes, {
    apply: writing,
    late,
    book,
    current,
  });
  const blocked = await writeBlocked(blockedInput(labels, forge, tracked), {
    apply: writing,
    late,
    current,
  });
  if (blocked.length > 0) planned.report.blocked = blocked;
  report.labels = planned.report;
}
