/**
 * `drive`, `hold` and `release`: a dispatch command label added to or
 * removed from a pull request (`dispatch/lib/requests.ts`), which the
 * dispatcher's tick reads (`dispatch/lib/labels.ts`). The repository's
 * `dispatch.labels` is read as the tick reads it, from the configuration
 * its default branch holds on the forge, so a repository with the labels
 * off is refused with the setting named, and the label carries the
 * repository's prefix.
 *
 * Checked before the write: `drive` only on an open pull request with no
 * drive ledger and no `drive` label yet; `hold` only where no `hold` label
 * is; `release` only where one is.
 */
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { attempt, ok, type Outcome } from "../../shared/outcome.ts";
import { commandLabel, type LabelConfig } from "../../dispatch/lib/labels.ts";
import { writeCommandLabel } from "../../dispatch/lib/requests.ts";
import { readSection } from "../../dispatch/lib/section.ts";
import { readDrive } from "../../ask/lib/drive.ts";
import { readDefaultConfig } from "../../ask/lib/forge.ts";
import { type AskContext, pullFor } from "../../ask/lib/station.ts";
import { NEXT_TICK, type Planned, refused, type TickReader } from "./plan.ts";
import type { LabelVerb } from "./verbs.ts";

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
  const section = attempt("refused", `${where} does not read`, () =>
    readSection(text.value, where),
  );
  return section.ok ? ok(section.value.section.labels) : section;
}

/** The pull request's labels and link, checked for `verb`; or why it cannot take it. */
async function pullFacts(
  ctx: AskContext,
  verb: LabelVerb,
): Promise<Outcome<{ labels: string[]; url: string }, "refused">> {
  const pr = ctx.address.key;
  if (verb !== "drive") {
    const pull = await pullFor(ctx);
    if (pull.absent) return refused(pull.answer.stateDetail);
    if (!pull.read)
      return refused(
        `pull request ${pr} did not read, so its labels are not known`,
      );
    return ok({ labels: pull.doc.labels, url: pull.doc.url });
  }
  const d = await readDrive(ctx);
  if (d.pull === null) return refused(d.answer.stateDetail);
  const { doc, read } = d.pull;
  if (!read)
    return refused(
      `pull request ${pr} did not read, so whether it is open is not known`,
    );
  if (doc.state !== "OPEN")
    return refused(
      `pull request ${pr} is ${doc.state.toLowerCase()}: the tick arms a drive only on an open one`,
    );
  if (d.comments === null)
    return refused(
      `the comments of pull request ${pr} did not read, so whether it has a drive ledger is not known`,
    );
  if (typeof d.ledger === "string")
    return refused(
      `whether pull request ${pr} has a drive ledger cannot be told: ${d.ledger}`,
    );
  if (d.ledger !== null)
    return refused(
      `pull request ${pr} already has a drive ledger (${d.answer.state}): the drive label adopts only a pull request with none; a stopped drive is picked up by its re-arm (jig ask ${ctx.name} says what it waits on)`,
    );
  return ok({ labels: doc.labels, url: doc.url });
}

const ACTS: Record<LabelVerb, string> = {
  drive:
    "which arms a drive on it where its dispatch file enables the rearm stage, and replaces the label with the drive's state label once the ledger exists",
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
  const label = commandLabel(config.value, verb === "drive" ? "drive" : "hold");
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
    undo:
      verb === "drive"
        ? `remove ${label} from the pull request until the tick has armed the drive`
        : `jig send ${ctx.name} ${add ? "release" : "hold"}`,
    notice: null,
    write: async () => {
      const wrote = await writeCommandLabel(ctx.address.repo, pr, label, add);
      return wrote.ok ? ok(url) : wrote;
    },
  });
}
