/**
 * `drive`, `rearm`, `withdraw-rearm`, `hold` and `release`: a dispatch command label added to or
 * removed from a pull request (`dispatch/lib/requests.ts`), which the
 * dispatcher's tick reads (`dispatch/lib/labels.ts`). The repository's
 * `dispatch.labels` is read as the tick reads it, from the configuration
 * its default branch holds on the forge, so a repository with the labels
 * off is refused with the setting named, and the label carries the
 * repository's prefix.
 *
 * Checked before the write: `drive` only on an open pull request with no
 * drive ledger and no `drive` label yet; `rearm` on a stopped drive with a
 * known local tree and no person's stop; `withdraw-rearm` only where a
 * request label remains; `hold` only where no `hold` label
 * is; `release` only where one is.
 */
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { commandLabel, type LabelConfig } from "../../dispatch/lib/labels.ts";
import { writeCommandLabel } from "../../dispatch/lib/requests.ts";
import { pendingRearm } from "../../dispatch/lib/actions/rearm-request.ts";
import {
  latestRearmBinding,
  type RearmStop,
  rearmableStop,
  writeRearmBinding,
} from "../../dispatch/lib/rearm-binding.ts";
import { readSection } from "../../dispatch/lib/section.ts";
import { type DriveReading, readDrive } from "../../ask/lib/drive.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import {
  readComments,
  readDefaultConfig,
  readPull,
} from "../../ask/lib/forge.ts";
import type { ClaimTarget } from "../../shared/records/forge-claims.ts";
import { snapshotFromListing } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { type AskContext, pullFor } from "../../ask/lib/station.ts";
import { NEXT_TICK, type Planned, refused, type TickReader } from "./plan.ts";
import type { LabelVerb } from "./verbs.ts";
import { openDrive } from "./open-drive.ts";
import { rearmTree } from "./rearm-tree.ts";

interface PullFacts {
  labels: string[];
  url: string;
  tree?: string;
  stop?: RearmStop;
}

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
): Promise<Outcome<PullFacts, "refused">> {
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
): Promise<Outcome<PullFacts, "refused">> {
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
async function rearmFacts(
  d: DriveReading,
  ctx: AskContext,
  doc: { labels: string[]; url: string },
): Promise<Outcome<PullFacts, "refused">> {
  const { ledger, ledgerCommentId } = d;
  if (ledger === null || typeof ledger === "string" || ledgerCommentId === null)
    return refused(
      `pull request ${ctx.address.key} has no readable drive ledger to re-arm`,
    );
  const fault = rearmFault(d, ctx);
  if (fault !== null) return refused(fault);
  const tree = await rearmTree(d, ctx);
  if (!tree.ok) return tree;
  return ok({
    labels: doc.labels,
    url: doc.url,
    tree: tree.value,
    stop: { comment: ledgerCommentId, generation: ledger.generation },
  });
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
  if (!rearmableStop(ledger))
    return `pull request ${pr}'s drive has completed: rearm requires an eligible stop`;
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

const ACTS: Record<LabelVerb, string> = {
  drive:
    "which arms a drive on it where its dispatch file enables the rearm stage, and replaces the label with the drive's state label once the ledger exists",
  rearm:
    "which re-arms the stopped drive on an admitted account in the existing worktree, and consumes the request once launched",
  "withdraw-rearm": "which no longer sees a pending re-arm from this request",
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
  "withdraw-rearm": "rearm",
  hold: "hold",
  release: "hold",
} as const;

function labelUndo(name: string, verb: LabelVerb, label: string): string {
  if (verb === "rearm") return `jig send ${name} withdraw-rearm`;
  if (verb === "withdraw-rearm") return `jig send ${name} rearm`;
  if (verb === "drive")
    return `remove ${label} from the pull request until the tick has armed the drive`;
  return `jig send ${name} ${verb === "release" ? "hold" : "release"}`;
}

function treeNotice(tree: string | undefined): string | null {
  return tree === undefined
    ? null
    : `The drive will use the existing worktree ${tree}. Account admission and the tree are checked again by the tick before launch.`;
}

/** Re-read the forge immediately before changing a re-arm request. */
async function rearmWriteFault(
  ctx: AskContext,
  target: ClaimTarget,
  label: string,
  stop: RearmStop | undefined,
  requestId: number | undefined,
): Promise<Outcome<void, "refused">> {
  const [pull, comments] = await Promise.all([
    readPull(ctx.reading, target.repo, target.number),
    readComments(ctx.reading, target.repo, target.number),
  ]);
  if (!pull.ok)
    return failed(
      "refused",
      `the pull request could not be read again: ${pull.failure.reason}`,
      pull.failure.cause,
    );
  if (!comments.ok)
    return failed(
      "refused",
      `the rearm request could not be read again: ${comments.failure.reason}`,
      comments.failure.cause,
    );
  const carries = pull.value.labels.includes(label);
  if (stop === undefined) {
    const newest = latestRearmBinding(target, ctx.login, comments.value, label);
    return carries && newest?.id === requestId
      ? ok(undefined)
      : refused(
          "the pending rearm request changed before it could be withdrawn",
        );
  }
  const { canonical } = snapshotFromListing(comments.value, ctx.login);
  return !carries &&
    pull.value.state === "OPEN" &&
    canonical?.comment.id === stop.comment &&
    canonical.parsed.kind === "ledger" &&
    canonical.parsed.ledger.generation === stop.generation &&
    rearmableStop(canonical.parsed.ledger)
    ? ok(undefined)
    : refused(
        "the pull request, drive stop or pending rearm request changed before the request could be sent",
      );
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
  const add = verb !== "release" && verb !== "withdraw-rearm";
  if (add && carries)
    return refused(`pull request ${pr} already carries ${label}`);
  if (!add && !carries)
    return refused(
      `pull request ${pr} carries no ${label}: there is no ${verb === "release" ? "hold to release" : "rearm request to withdraw"}`,
    );
  const { url, stop } = facts.value;
  const target = { repo: ctx.address.repo, number: pr };
  const tick = tickReader(ctx, verb);
  const rearm = stop !== undefined || verb === "withdraw-rearm";
  let requestId: number | undefined;
  if (verb === "withdraw-rearm") {
    const comments = await readComments(ctx.reading, target.repo, pr);
    if (!comments.ok) return refused(comments.failure.reason);
    requestId = latestRearmBinding(
      target,
      ctx.login,
      comments.value,
      label,
    )?.id;
  }
  const binding = rearm
    ? " and a rearm request record on the pull request"
    : "";
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb,
    writesAs,
    record: `the label ${label}, ${add ? "added to" : "removed from"} pull request ${pr}${binding}`,
    where: url,
    reader: tick.reader(NEXT_TICK),
    tick,
    undo: labelUndo(ctx.name, verb, label),
    notice: treeNotice(facts.value.tree),
    write: async () => {
      let boundUrl: string | null = null;
      if (rearm) {
        const fault = await rearmWriteFault(
          ctx,
          target,
          label,
          stop,
          requestId,
        );
        if (!fault.ok) return fault;
        const bound = await writeRearmBinding(
          target,
          ctx.login,
          label,
          stop ?? null,
          { ...(requestId === undefined ? {} : { requestId }) },
        );
        if (!bound.ok) return bound;
        boundUrl = bound.value;
        if (verb === "withdraw-rearm" && boundUrl !== null) {
          const comments = await readComments(ctx.reading, target.repo, pr);
          if (!comments.ok)
            return ok({ sent: boundUrl, unsent: comments.failure.reason });
          if (
            latestRearmBinding(target, ctx.login, comments.value, label)?.id !==
            requestId
          )
            return ok({
              sent: boundUrl,
              unsent: "the label is now held by a different rearm request",
            });
        }
      }
      const wrote = await writeCommandLabel(ctx.address.repo, pr, label, add);
      if (wrote.ok) return ok(url);
      return boundUrl === null
        ? wrote
        : ok({ sent: boundUrl, unsent: wrote.failure.reason });
    },
  });
}
