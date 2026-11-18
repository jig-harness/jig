/**
 * `answer <key> --approve|--choose <option>` to a pickup's decision on an
 * item of a tracker other than the forge: the comment a person could type
 * on the item, `answer <key>: approve [<digest>]` or `answer <key>: choose
 * <option> [<digest>]`, with a `note <key>:` line when `--note` gives one,
 * posted through the tracker interface as the user the tracker's credential
 * acts as here. The tick on the host that owns the repository reads the
 * item's comments (`dispatch/lib/tracker-answers.ts`) and carries out the
 * option once.
 *
 * The comment carries no hidden record: a tracker keeps a comment in its own
 * document format (Jira's document nodes, Linear's editor), which need not
 * keep an HTML comment as written, and the tick reads the answer line alone.
 *
 * Checked before the write, beside what every answer to a need's decision is
 * checked for (`answer-station.ts`): the tracker names who wrote each
 * comment, without which the tick cannot count an answer there; the
 * tracker's user here is not the user the tick leaves out, the user its own
 * tracker credential acts as; and `--as`, when given, names that user. The
 * tick runs on the host that owns the repository, with the credential a
 * send there uses, so a send there is refused. From another host, the user
 * the tick leaves out is taken to be the repository's factory identity
 * (`dispatch.identity`). Where that user cannot be told (no factory
 * identity, or a machine that cannot tell whether it owns the repository),
 * the plan's notice says the tick may not read the answer.
 */
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import type { TrackerKeyForm } from "../../shared/address.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { readSection, trackerConfigOf } from "../../dispatch/lib/section.ts";
import { readDefaultConfig } from "../../ask/lib/forge.ts";
import { ownsRepository } from "../../ask/lib/local.ts";
import { issueKeysOf } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { failureText } from "../../dispatch/lib/text.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import type {
  Tracker,
  TrackerUser,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { within } from "../../ask/lib/reading.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import type { AnswerRequest } from "./answer-request.ts";
import { type Sender, TICK } from "./answer-parks.ts";
import {
  keyedDecision,
  lineNeeds,
  requestFault,
  STATION_READER,
  STATION_UNDO,
  stationChoice,
} from "./answer-station.ts";
import { type Planned, refused, trackerWriter } from "./plan.ts";

type OneAnswer = Extract<AnswerRequest, { all: false }>;

/** The tracker an answer is written through here, the repository's factory identity, and whether the tick that reads the answer runs here. */
export interface TrackerHere {
  tracker: Tracker;
  identity: string | null;
  /** Whether this machine owns the repository, so its tick reads answers with this machine's tracker credential, or why that cannot be told. */
  owner: Outcome<boolean, "unreadable">;
  /** The item key form of the tracker, when the settings were read from the repository; the item is checked against it. */
  keys?: TrackerKeyForm;
}

/**
 * The tracker of the repository, opened from the settings the tick reads:
 * the configuration file its default branch holds on the forge, never the
 * checkout's, so an unmerged edit cannot send the answer to another tracker
 * or remove the factory identity it is checked against. The checkout only
 * supplies the root the adapter opens from; why not opened otherwise.
 */
export async function openTrackerHere(
  ctx: AskContext,
  checkout: string | null,
): Promise<Outcome<TrackerHere, "refused">> {
  if (checkout === null)
    return refused("no checkout of the repository is known here");
  const { repo } = ctx.address;
  const where = `${OVERLAY_RELPATH} on ${repo}'s default branch`;
  const text = await readDefaultConfig(ctx.reading, repo);
  if (!text.ok)
    return refused(
      `the tracker and factory identity of ${repo} cannot be told: ${where} did not read (${text.failure.reason})`,
    );
  const read = readSection(text.value, where);
  if (!read.ok)
    return failed(
      "refused",
      `${where} does not read: ${read.failure.reason}`,
      read.failure.cause,
    );
  const { values, section } = read.value;
  const config = attempt("refused", `${where} does not read`, () =>
    trackerConfigOf(values, repo),
  );
  if (!config.ok) return config;
  const keys = issueKeysOf(config.value);
  if (keys === null)
    return refused(
      `${where} names no tracker team, so its item keys have no form`,
    );
  const opened = attempt("refused", "the tracker does not open here", () =>
    openTracker(config.value, checkout),
  );
  return opened.ok
    ? ok({
        tracker: opened.value,
        identity: section.identity,
        owner: ownsRepository(repo),
        keys: (input: string) => keys.normalize(input),
      })
    : opened;
}

/** A tracker read here, bounded by the reading's deadline: its value, or why it did not read. */
async function readHere<T>(
  ctx: AskContext,
  what: string,
  read: (signal: AbortSignal) => Promise<T>,
): Promise<Outcome<T, "refused">> {
  try {
    const got = await within(ctx.reading.sourceSec(), read);
    return got === null
      ? refused(`${what} did not answer in time`)
      : ok(got.value);
  } catch (error) {
    return refused(`${what} did not read: ${failureText(error)}`);
  }
}

/** What the person can do instead of an answer the tick would not read. */
const INSTEAD =
  "answer on the tracker as another user, or give the dispatcher a tracker user of its own";

/**
 * Whether the tick would read an answer `viewer` writes: refused when
 * `viewer` is the user the tick leaves out, or when the factory identity
 * that user is taken to be cannot be looked up; otherwise the notice to
 * show when who the tick leaves out cannot be told here, `null` when it can.
 */
async function readByTick(
  ctx: AskContext,
  here: TrackerHere,
  viewer: TrackerUser,
): Promise<Outcome<string | null, "refused">> {
  const { identity, tracker, owner } = here;
  const { repo } = ctx.address;
  if (owner.ok && owner.value)
    return refused(
      `this machine owns ${repo}, so its tick reads the answers with the tracker credential a send here uses, which acts as ${viewer.name}; the tick never counts a comment by the user its own tracker credential acts as, so it would not read this answer: ${INSTEAD}`,
    );
  const unsure = owner.ok
    ? null
    : `whether this machine owns ${repo}, and so reads its answers with the tracker credential a send here uses (which acts as ${viewer.name}), cannot be told: ${owner.failure.reason}; if it does, the tick will not read this answer: ${INSTEAD}`;
  if (identity === null)
    return ok(
      [
        unsure,
        `the repository names no factory identity (dispatch.identity), so whether ${viewer.name} is the user the tick's own tracker credential acts as on the host that owns the repository cannot be told here; if it is, the tick will not read this answer: ${INSTEAD}`,
      ]
        .filter((n) => n !== null)
        .join("; "),
    );
  const factory = await readHere(ctx, "the factory identity", (signal) =>
    tracker.user(identity, signal),
  );
  if (!factory.ok)
    return refused(
      `the factory identity ${identity} could not be looked up, so it cannot be told apart from the user the tracker's credential acts as: ${factory.failure.reason}`,
    );
  return factory.value.id === viewer.id
    ? refused(
        `the tracker's credential here acts as ${viewer.name}, the factory identity ${identity}, whose comments the tick never counts as an answer; ${INSTEAD}`,
      )
    : ok(unsure);
}

/** The sender an answer through `here` writes as, the user its credential acts as, with the notice its plan adds; refused when the tick would not read that user's answer. */
async function trackerSender(
  ctx: AskContext,
  here: TrackerHere,
  options: { as: string | undefined; dryRun: boolean },
): Promise<Outcome<{ sender: Sender; notice: string | null }, "refused">> {
  const { tracker } = here;
  const writer = await trackerWriter(
    tracker,
    ctx.reading.sourceSec(),
    options.as,
  );
  if (!writer.ok) return writer;
  const { viewer, login } = writer.value;
  const read = await readByTick(ctx, here, viewer);
  if (!read.ok) return read;
  return ok({
    sender: {
      login,
      writesAs: `${login}, the user the tracker's credential acts as here`,
      dryRun: options.dryRun,
      as: options.as,
    },
    notice: read.value,
  });
}

/** Post `lines` on `item` through `tracker`: the link the person opens, or why the tracker did not take it. */
async function postOn(
  tracker: Tracker,
  item: string,
  lines: string[],
  link: string,
): Promise<Outcome<string, "refused">> {
  try {
    await tracker.postComment(
      item,
      lines.join("\n"),
      AbortSignal.timeout(60_000),
    );
  } catch (error) {
    return refused(
      `the tracker did not take the comment on ${item}: ${failureText(error)}`,
    );
  }
  return ok(link);
}

/**
 * The plan of an answer to a decision answered on another tracker's item,
 * or `null` when the address's decision keyed `request.key` is not one
 * (another reader plans it, or refuses it).
 */
export async function planTrackerAnswer(
  ctx: AskContext,
  request: OneAnswer,
  options: {
    as: string | undefined;
    dryRun: boolean;
    open: () =>
      | Outcome<TrackerHere, "refused">
      | Promise<Outcome<TrackerHere, "refused">>;
  },
): Promise<Planned | null> {
  const needs = lineNeeds(ctx);
  if (typeof needs === "string") return null;
  const found = keyedDecision(needs, request.key);
  if (found === undefined || found.decision.answer?.on !== "tracker")
    return null;
  const { need, decision } = found;
  const fault = requestFault(request, options, decision);
  if (fault !== null) return refused(fault);
  const opened = await options.open();
  if (!opened.ok) return opened;
  const { tracker, keys } = opened.value;
  const item = need.target;
  if (keys !== undefined && keys(item) !== item)
    return refused(
      `${item} is not an item key of the tracker the repository's default branch names, so the answer is not written there`,
    );
  if (tracker.commentAuthors !== true)
    return refused(
      `${item} is an item of the ${tracker.adapter} tracker, which does not name who wrote each comment, so the tick cannot count an answer there; settle it on the tracker by hand`,
    );
  const sent = await trackerSender(ctx, opened.value, options);
  if (!sent.ok) return sent;
  const { sender, notice } = sent.value;
  const chosen = stationChoice(ctx, request, sender, decision);
  if (!chosen.ok) return chosen;
  const { lines, detail } = chosen.value;
  return ok({
    address: ctx.name,
    repo: ctx.address.repo,
    verb: "answer",
    writesAs: sender.writesAs,
    record: `a comment on ${item} on the ${tracker.adapter} tracker: ${lines.map((l) => `"${l}"`).join(" and ")}`,
    where: need.url ?? item,
    reader: STATION_READER(ctx),
    tick: TICK,
    undo: STATION_UNDO,
    notice: [
      "the tick acts only on an answer that names the decision's digest, by a member the tracker vouches for other than the user the dispatcher's own tracker credential acts as, and only when every person's latest answer chooses the same option",
      ...(notice === null ? [] : [notice]),
    ].join("; "),
    detail,
    write: () => postOn(tracker, item, lines, need.url ?? item),
  });
}
