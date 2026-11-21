/** Stop or release a pickup on its dispatcher host without writing the tracker item. */
import { formatAddress } from "../../shared/address.ts";
import { ok, type Outcome } from "../../shared/outcome.ts";
import { statePath } from "../../dispatch/lib/state.ts";
import { setPersonPickupHold } from "../../dispatch/lib/person-pickup-holds.ts";
import {
  type PickupCondition,
  pickupConditionWords,
} from "../../dispatch/lib/pickup-condition.ts";
import type { AskContext } from "../../ask/lib/station.ts";
import {
  openTrackerHere,
  readHere,
  type TrackerHere,
} from "./answer-tracker.ts";
import {
  NEXT_TICK,
  type Plan,
  type Planned,
  refused,
  type TickReader,
  trackerWriter,
} from "./plan.ts";

const TICK: TickReader = { stage: "pickup", reader: (tick) => tick };

/** The item key and the condition's dependency in this tracker's form, or why either is not one of its items. */
function trackerKeys(
  opened: TrackerHere,
  written: string,
  condition: PickupCondition | undefined,
): Outcome<{ key: string; condition: PickupCondition | undefined }, "refused"> {
  const key = opened.keys?.(written);
  if (typeof key !== "string")
    return refused(
      `${written} is not an item key of this repository's tracker`,
    );
  if (condition?.kind !== "item-closed") return ok({ key, condition });
  const dependency = opened.keys?.(condition.item);
  if (typeof dependency !== "string" || dependency === key)
    return refused(
      "--until-closed needs another item on this repository's tracker",
    );
  return ok({ key, condition: { kind: "item-closed", item: dependency } });
}

/** What the plan says it records and how it is undone. */
function holdWords(
  address: string,
  key: string,
  holding: boolean,
  condition: PickupCondition | undefined,
): Pick<Plan, "record" | "undo" | "notice"> {
  const closing = condition?.kind === "item-closed";
  return {
    record: holding
      ? `hold pickup of ${key}${condition === undefined ? "" : `, waiting for ${pickupConditionWords(condition)}`}`
      : `release the local hold on ${key}`,
    undo: `jig send '${address}' ${holding ? "release" : "hold"}${closing ? ", then remove the blocker on the tracker if the tick recorded it" : ""}`,
    notice: closing
      ? "The applied tick also records the blocker on trackers that support it."
      : null,
  };
}

export async function planPickupHold(
  ctx: AskContext,
  checkout: string | null,
  verb: "hold" | "release",
  as: string | undefined,
  condition?: PickupCondition,
): Promise<Planned> {
  const { repo } = ctx.address;
  const opened = await openTrackerHere(ctx, checkout);
  if (!opened.ok) return opened;
  const { owner, tracker } = opened.value;
  if (!owner.ok) return refused(owner.failure.reason);
  if (!owner.value)
    return refused(`run this command on the dispatcher host that owns ${repo}`);
  const keys = trackerKeys(opened.value, ctx.address.key, condition);
  if (!keys.ok) return keys;
  const { key } = keys.value;
  const waitsFor = keys.value.condition;
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
    ...holdWords(address, key, holding, waitsFor),
    where: statePath(root),
    reader: TICK.reader(NEXT_TICK),
    tick: TICK,
    write: async () =>
      setPersonPickupHold(
        repo,
        key,
        holding
          ? {
              by: login,
              title,
              url,
              ...(waitsFor === undefined ? {} : { condition: waitsFor }),
            }
          : null,
        root,
      ),
  });
}
