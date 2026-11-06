/**
 * `assign`: the item assigned to the repository's factory identity
 * (`dispatch.identity`) in a dispatch state (`dispatch.states`), through the
 * tracker interface (`dispatch/lib/requests.ts`). The dispatcher's tick
 * starts a pick-up for it, and only when the person who made the
 * assignment can write to the repository: `send` adds no authority, it
 * writes as the user the tracker's credential acts as here.
 *
 * The identity, the states and the tracker are the ones the tick reads: the
 * configuration file the repository's default branch holds on the forge,
 * never the checkout's, so an unmerged edit cannot send the assignment
 * where, or in a state, the tick will not look.
 *
 * Checked before the write: the repository names a factory identity, and
 * the item is open, assigned to nobody (the identity included) and not in a
 * state of work in progress.
 */
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { attempt, ok, type Outcome } from "../../shared/outcome.ts";
import { assignPickup } from "../../dispatch/lib/requests.ts";
import { readSection, trackerConfigOf } from "../../dispatch/lib/section.ts";
import { failureText } from "../../dispatch/lib/text.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import { issueKeysOf } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import type { CanonicalState } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { type RepoTracker, readPickup } from "../../ask/lib/pickup.ts";
import { readDefaultConfig } from "../../ask/lib/forge.ts";
import { formatAddress } from "../../shared/address.ts";
import { within } from "../../ask/lib/reading.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { type Planned, refused, writerLogin } from "./plan.ts";

/** What the tick reads from the repository's default branch: its tracker, factory identity and dispatch states. */
async function tickSettings(
  ctx: AskContext,
  repoTracker: RepoTracker,
): Promise<
  Outcome<{ tracked: RepoTracker; identity: string; key: string }, "refused">
> {
  const { repo } = ctx.address;
  const where = `${OVERLAY_RELPATH} on ${repo}'s default branch`;
  const text = await readDefaultConfig(ctx.reading, repo);
  if (!text.ok)
    return refused(
      `the factory identity of ${repo} cannot be told: ${where} did not read (${text.failure.reason})`,
    );
  const read = attempt("refused", `${where} does not read`, () => {
    const { values, section } = readSection(text.value, where);
    return { section, config: trackerConfigOf(values, repo) };
  });
  if (!read.ok) return read;
  const { section, config } = read.value;
  const { identity } = section;
  if (identity === null)
    return refused(
      `assign writes the item assigned to the factory identity, and ${repo} names none: set dispatch.identity in ${OVERLAY_RELPATH}`,
    );
  const keys = issueKeysOf(config);
  const key = keys?.normalize(ctx.address.key) ?? null;
  if (keys === null || key === null)
    return refused(
      `${ctx.address.key} is not an item key of the tracker ${where} names${keys === null ? "" : `, whose keys look like ${keys.example}`}`,
    );
  return ok({
    tracked: {
      ...repoTracker,
      config,
      keys: (input) => keys.normalize(input),
      identity,
      states: section.states,
    },
    identity,
    key,
  });
}

/** The plan of an assignment, or why the item cannot take it. */
export async function planAssign(
  written: AskContext,
  repoTracker: RepoTracker,
  as: string | undefined,
): Promise<Planned> {
  const { repo } = written.address;
  const settings = await tickSettings(written, repoTracker);
  if (!settings.ok) return settings;
  const { tracked, identity, key } = settings.value;
  const address = { ...written.address, key };
  const ctx: AskContext = { ...written, address, name: formatAddress(address) };
  const tracker = openTracker(tracked.config, tracked.root);
  let viewer: string | null = null;
  try {
    viewer =
      (await within(ctx.reading.sourceSec(), () => tracker.viewer()))?.value
        .name ?? null;
  } catch (error) {
    return refused(
      `the tracker did not name the user it acts as here: ${failureText(error)}`,
    );
  }
  const login = writerLogin(viewer, as, "the tracker");
  if (!login.ok) return login;
  const { answer, issue } = await readPickup(ctx, tracked);
  if (!answer.found || issue === null) return refused(answer.stateDetail);
  if (answer.state !== "not assigned")
    return refused(
      `${key} is ${answer.state} (${answer.stateDetail}): assign writes an item nobody holds yet`,
    );
  if (issue.assignee !== null)
    return refused(
      `${key} is assigned to ${issue.assignee}; assigning it to ${identity} would take it from them, so unassign it first if that is meant`,
    );
  const states = tracked.states as CanonicalState[];
  const moveFor = (stateName: string): CanonicalState | null =>
    states.some((s) => tracker.stateName(s) === stateName)
      ? null
      : (states[0] ?? null);
  if (issue.state.type === "started")
    return refused(
      `${key} is ${issue.state.name}, a state of work in progress; assign does not move it back to a dispatch state`,
    );
  const move = moveFor(issue.state.name);
  return ok({
    address: ctx.name,
    repo,
    verb: "assign",
    writesAs: `${login.value}, the user the tracker's credential acts as here`,
    record: `${key} assigned to ${identity}${
      move === null
        ? `, in ${issue.state.name}, a dispatch state`
        : `, and moved from ${issue.state.name} to ${tracker.stateName(move)}, a dispatch state`
    }`,
    where: issue.url ?? key,
    reader:
      "the dispatcher's next tick where its dispatch file enables the pickup stage, which starts the pick-up once it finds that the person who made the assignment can write to the repository",
    undo: `assign ${key} to nobody on the tracker before the tick starts the pick-up`,
    notice: null,
    write: async () => {
      const wrote = await assignPickup(tracker, key, identity, move, moveFor);
      return wrote.ok ? ok(issue.url ?? key) : wrote;
    },
  });
}
