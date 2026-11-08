/**
 * `drive`, `rearm`, `hold` and `release`: a dispatch command label added to or
 * removed from a pull request (`dispatch/lib/requests.ts`), which the
 * dispatcher's tick reads (`dispatch/lib/labels.ts`). The repository's
 * `dispatch.labels` is read as the tick reads it, from the configuration
 * its default branch holds on the forge, so a repository with the labels
 * off is refused with the setting named, and the label carries the
 * repository's prefix.
 *
 * Checked before the write: `drive` only on an open pull request with no
 * drive ledger and no `drive` label yet; `rearm` on a stopped drive with a
 * known local tree and no person's stop; `hold` only where no `hold` label
 * is; `release` only where one is.
 */
import { existsSync } from "node:fs";
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { commandLabel, type LabelConfig } from "../../dispatch/lib/labels.ts";
import { writeCommandLabel } from "../../dispatch/lib/requests.ts";
import { pendingRearm } from "../../dispatch/lib/actions/rearm-request.ts";
import { readSection } from "../../dispatch/lib/section.ts";
import { type DriveReading, readDrive } from "../../ask/lib/drive.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { readDefaultConfig } from "../../ask/lib/forge.ts";
import { type AskContext, pullFor } from "../../ask/lib/station.ts";
import { NEXT_TICK, type Planned, refused, type TickReader } from "./plan.ts";
import type { LabelVerb } from "./verbs.ts";
import { openDrive } from "./open-drive.ts";

/** The repository's dispatch labels as the tick reads them, or why they cannot be told. */
async function labelConfig(
  ctx: AskContext,
): Promise<Outcome<LabelConfig, "refused">> {
  const where = `${OVERLAY_RELPATH} on ${ctx.address.repo}'s default branch`;
  const text = await readDefaultConfig(ctx.reading, ctx.address.repo);
  if (!text.ok)
    return refused(
      `whether ${ctx.address.repo} has its dispatch labels on cannot be told: ${where} did not read (${text.failure.reason})`,
    );
  const section = readSection(text.value, where);
  return section.ok
    ? ok(section.value.section.labels)
    : failed(
        "refused",
        `${where} does not read: ${section.failure.reason}`,
        section.failure.cause,
      );
}

/** The pull request's labels and link, checked for `verb`; or why it cannot take it. */
async function pullFacts(
  ctx: AskContext,
  verb: LabelVerb,
): Promise<
  Outcome<{ labels: string[]; url: string; tree?: string }, "refused">
> {
  const pr = ctx.address.key;
  if (verb !== "drive" && verb !== "rearm") {
    const pull = await pullFor(ctx);
    if (pull.absent) return refused(pull.answer.stateDetail);
    if (!pull.read)
      return refused(
        `pull request ${pr} did not read, so its labels are not known`,
      );
    return ok({ labels: pull.doc.labels, url: pull.doc.url });
  }
  return driveFacts(ctx, verb);
}

/** The drive-specific state both arm commands require. */
async function driveFacts(
  ctx: AskContext,
  verb: LabelVerb,
): Promise<
  Outcome<{ labels: string[]; url: string; tree?: string }, "refused">
> {
  const pr = ctx.address.key;
  const d = await readDrive(ctx);
  const opened = openDrive(d, pr, "the tick arms a drive only on an open one");
  if (!opened.ok) return opened;
  const doc = opened.value;
  if (d.comments === null)
    return refused(
      `the comments of pull request ${pr} did not read, so whether it has a drive ledger is not known`,
    );
  if (typeof d.ledger === "string")
    return refused(
      `whether pull request ${pr} has a drive ledger cannot be told: ${d.ledger}`,
    );
  if (verb === "rearm") return rearmFacts(d, ctx, doc);
  if (d.ledger !== null)
    return refused(
      `pull request ${pr} already has a drive ledger (${d.answer.state}): the drive label adopts only a pull request with none; a stopped drive is picked up by its re-arm (jig ask ${ctx.name} says what it waits on)`,
    );
  return ok({ labels: doc.labels, url: doc.url });
}

/** The stopped drive's local tree, after its eligibility is checked. */
function rearmFacts(
  d: DriveReading,
  ctx: AskContext,
  doc: { labels: string[]; url: string },
): Outcome<{ labels: string[]; url: string; tree?: string }, "refused"> {
  const fault = rearmFault(d, ctx);
  if (fault !== null) return refused(fault);
  const tree = rearmTree(d);
  if (!tree || !existsSync(tree))
    return refused(
      `no existing worktree of pull request ${ctx.address.key} is known on this machine: rearm never opens a replacement tree`,
    );
  return ok({ labels: doc.labels, url: doc.url, tree });
}

/** A stopped ledger's eligibility, before local tree selection. */
function rearmFault(d: DriveReading, ctx: AskContext): string | null {
  const pr = ctx.address.key;
  const ledger = d.ledger;
  if (ledger === null || typeof ledger === "string")
    return `pull request ${pr} has no readable drive ledger to re-arm`;
  if (ledger.driver.state !== "stopped")
    return `pull request ${pr}'s drive is running: rearm takes a stopped drive`;
  if (
    ledger.driver.personStop !== undefined ||
    ledger.driver.exit === DRIVE_EXIT.MAILBOX_STOPPED ||
    ledger.driver.exit === DRIVE_EXIT.MAILBOX_PAUSE_TIMEOUT
  )
    return `pull request ${pr}'s drive was stopped by a person: rearm refuses a person's stop`;
  if (d.records.some((r) => pendingRearm(r.record)))
    return `pull request ${pr} still has a delivered rearm awaiting acknowledgment; let the tick finish removing its request label before sending another`;
  if (d.answer.holder !== "none")
    return `pull request ${pr}'s drive is still held on ${d.answer.holder.host}: rearm requires a stopped drive with no active launch`;
  return lockFault(d, ctx);
}

/** An unreadable or possibly live local lock prevents a second launch. */
function lockFault(d: DriveReading, ctx: AskContext): string | null {
  const unread = ctx.reading
    .sources()
    .records.find((s) => s.record === "drive-lock" && !s.read);
  if (unread !== undefined)
    return `the driver lock could not be read: ${unread.detail ?? "no reason given"}; rearm waits until its state is known`;
  if (d.row !== null && d.row.lock !== "empty" && d.row.lock !== "stale")
    return `the local driver lock is ${d.row.lock}: rearm requires a stopped drive with no live or uncertain lock`;
  return null;
}

/** The local listing's tree, else the most recent launch's tree. */
function rearmTree(d: DriveReading): string | undefined {
  if (d.row?.worktree) return d.row.worktree;
  const launched = [...d.records].sort((a, b) =>
    b.record.createdAt.localeCompare(a.record.createdAt),
  );
  return launched.find((r) => r.record.workspace !== null)?.record.workspace
    ?.path;
}

const ACTS: Record<LabelVerb, string> = {
  drive:
    "which arms a drive on it where its dispatch file enables the rearm stage, and replaces the label with the drive's state label once the ledger exists",
  rearm:
    "which re-arms the stopped drive on an admitted account in the existing worktree, and consumes the request once launched",
  hold: "which keeps every stage off the pull request while the label is there",
  release: "which starts the stages the pull request wants again",
};

/** The tick reading a label: under the followup stage for a follow-up's, the rearm stage for a drive's. */
function tickReader(ctx: AskContext, verb: LabelVerb): TickReader {
  return {
    stage: ctx.address.station === "followup" ? "followup" : "rearm",
    reader: (tick) => `${tick}, ${ACTS[verb]}`,
  };
}

/** The plan of a label verb, or why the pull request cannot take it. */
const COMMAND_FOR = {
  drive: "drive",
  rearm: "rearm",
  hold: "hold",
  release: "hold",
} as const;

function labelUndo(name: string, verb: LabelVerb, label: string): string {
  if (verb === "drive" || verb === "rearm")
    return `remove ${label} from the pull request until the tick has armed the drive`;
  return `jig send ${name} ${verb === "release" ? "hold" : "release"}`;
}

function treeNotice(tree: string | undefined): string | null {
  return tree === undefined
    ? null
    : `The drive will use the existing worktree ${tree}. Account admission and the tree are checked again by the tick before launch.`;
}

export async function planLabel(
  ctx: AskContext,
  verb: LabelVerb,
  writesAs: string,
): Promise<Planned> {
  const config = await labelConfig(ctx);
  if (!config.ok) return config;
  if (!config.value.enabled)
    return refused(
      `${verb} writes a dispatch label, and ${ctx.address.repo} has them off: dispatch.labels.enabled is not true in ${OVERLAY_RELPATH} on its default branch`,
    );
  const label = commandLabel(config.value, COMMAND_FOR[verb]);
  const facts = await pullFacts(ctx, verb);
  if (!facts.ok) return facts;
  const pr = Number(ctx.address.key);
  const carries = facts.value.labels.includes(label);
  if (verb !== "release" && carries)
    return refused(`pull request ${pr} already carries ${label}`);
  if (verb === "release" && !carries)
    return refused(
      `pull request ${pr} carries no ${label}: there is no hold to release`,
    );
  const add = verb !== "release";
  const { url } = facts.value;
  const tick = tickReader(ctx, verb);
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb,
    writesAs,
    record: `the label ${label}, ${add ? "added to" : "removed from"} pull request ${pr}`,
    where: url,
    reader: tick.reader(NEXT_TICK),
    tick,
    undo: labelUndo(ctx.name, verb, label),
    notice: treeNotice(facts.value.tree),
    write: async () => {
      const wrote = await writeCommandLabel(ctx.address.repo, pr, label, add);
      return wrote.ok ? ok(url) : wrote;
    },
  });
}
