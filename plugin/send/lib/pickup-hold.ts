/** Stop or release a pickup on its dispatcher host without writing the tracker item. */
import { formatAddress } from "../../shared/address.ts";
import { ok } from "../../shared/outcome.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import { setPersonPickupHold } from "../../dispatch/lib/person-pickup-holds.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import { openTrackerHere, readHere } from "./answer-tracker.ts";
import {
  NEXT_TICK,
  type Planned,
  refused,
  type TickReader,
  trackerWriter,
} from "./plan.ts";

const TICK: TickReader = { stage: "pickup", reader: (tick) => tick };

export async function planPickupHold(
  ctx: AskContext,
  checkout: string | null,
  verb: "hold" | "release",
  as: string | undefined,
): Promise<Planned> {
  const { repo } = ctx.address;
  const opened = await openTrackerHere(ctx, checkout);
  if (!opened.ok) return opened;
  const { owner, tracker } = opened.value;
  if (!owner.ok) return refused(owner.failure.reason);
  if (!owner.value)
    return refused(`run this command on the dispatcher host that owns ${repo}`);
  const key = opened.value.keys?.(ctx.address.key);
  if (typeof key !== "string")
    return refused(
      `${ctx.address.key} is not an item key of this repository's tracker`,
    );
  const writer = await trackerWriter(tracker, ctx.reading.sourceSec(), as);
  if (!writer.ok) return writer;
  const issue = await readHere(ctx, key, (signal) =>
    tracker.poolIssue(key, signal),
  );
  if (!issue.ok) return issue;
  if (issue.value === null) return refused(`the tracker has no item ${key}`);
  const { login } = writer.value;
  const { title, url } = issue.value;
  const address = formatAddress({ ...ctx.address, key });
  const holding = verb === "hold";
  const root = ctx.dispatcher ?? undefined;
  return ok({
    address,
    repo,
    verb,
    writesAs: `${login}, the user the tracker's credential acts as here`,
    record: holding
      ? `hold pickup of ${key}`
      : `release the local hold on ${key}`,
    where: statePath(root),
    reader: TICK.reader(NEXT_TICK),
    tick: TICK,
    undo: `jig send '${address}' ${holding ? "release" : "hold"}`,
    notice: null,
    write: async () =>
      setPersonPickupHold(
        repo,
        key,
        holding ? { by: login, title, url } : null,
        root,
      ),
  });
}
