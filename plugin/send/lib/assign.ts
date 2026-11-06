/**
 * `assign`: the item assigned to the repository's factory identity
 * (`dispatch.identity`) in a dispatch state (`dispatch.states`), through the
 * tracker interface (`dispatch/lib/requests.ts`). The dispatcher's tick
 * starts a pick-up for it, and only when the person who made the
 * assignment can write to the repository: `send` adds no authority, it
 * writes as the user the tracker's credential acts as here.
 *
 * Checked before the write: the repository names a factory identity, and
 * the item is open, assigned to nobody (the identity included) and not in a
 * state of work in progress.
 */
import { OVERLAY_RELPATH } from "../../shared/config-layers.ts";
import { ok } from "../../shared/outcome.ts";
import { assignPickup } from "../../dispatch/lib/requests.ts";
import { failureText } from "../../dispatch/lib/text.ts";
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import type { CanonicalState } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { type RepoTracker, readPickup } from "../../ask/lib/pickup.ts";
import { within } from "../../ask/lib/reading.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { type Planned, refused, writerLogin } from "./plan.ts";

/** The plan of an assignment, or why the item cannot take it. */
export async function planAssign(
  ctx: AskContext,
  repoTracker: RepoTracker,
  as: string | undefined,
): Promise<Planned> {
  const { identity } = repoTracker;
  const { repo, key } = ctx.address;
  if (identity === null)
    return refused(
      `assign writes the item assigned to the factory identity, and ${repo} names none: set dispatch.identity in ${OVERLAY_RELPATH}`,
    );
  const tracker = openTracker(repoTracker.config, repoTracker.root);
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
  const { answer, issue } = await readPickup(ctx, repoTracker);
  if (!answer.found || issue === null) return refused(answer.stateDetail);
  if (answer.state !== "not assigned")
    return refused(
      `${key} is ${answer.state} (${answer.stateDetail}): assign writes an item nobody holds yet`,
    );
  if (issue.assignee !== null)
    return refused(
      `${key} is assigned to ${issue.assignee}; assigning it to ${identity} would take it from them, so unassign it first if that is meant`,
    );
  const states = repoTracker.states as CanonicalState[];
  const inState = states.some((s) => tracker.stateName(s) === issue.state.name);
  if (!inState && issue.state.type === "started")
    return refused(
      `${key} is ${issue.state.name}, a state of work in progress; assign does not move it back to a dispatch state`,
    );
  const move = inState ? null : (states[0] ?? null);
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
      const wrote = await assignPickup(tracker, key, identity, move);
      return wrote.ok ? ok(issue.url ?? key) : wrote;
    },
  });
}
