/** Each pickup dependency is checked once per tick and terminal results are kept with the hold. */
import { Defect, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { swallow } from "../../shared/errors.ts";
import {
  failedBy,
  failureOf,
  POLICIES,
} from "../../shared/outbound/failure.ts";
import { ghRepoEnvFor } from "../../shared/gh-repo-env.ts";
import { readPrLiveness } from "../../shared/gh-conditional.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  personPickupHolds,
  settlePickupHold,
  type PersonPickupHold,
} from "./person-pickup-holds.ts";
import {
  pickupConditionWords,
  type PickupCondition,
} from "./pickup-condition.ts";
import {
  ended,
  secondsLeft,
  within,
  type TickBound,
} from "./sources/bounded.ts";
import { facetBound } from "./sources/tracker-facets.ts";
import { holdsItem, pickupItems } from "./launch-pickups.ts";
import type { ReadRecord } from "./launches.ts";
import { readFailureOf } from "./read-failures.ts";
import { failureText } from "./text.ts";
import type { RepoReport } from "./types.ts";

type ConditionState = "open" | "cleared" | "closed-unmerged";
type ConditionObservation = Outcome<ConditionState, "unreadable">;

interface ConditionRead {
  slug: string;
  root: string;
  checkout: string;
  apply: boolean;
  tracker: Tracker;
  bound?: TickBound | undefined;
  records: readonly ReadRecord[];
}

async function conditionState(
  condition: PickupCondition,
  input: ConditionRead,
): Promise<ConditionObservation> {
  const bound = facetBound(input.bound?.deadline);
  if (ended(bound)) return failed("unreadable", "the tick's deadline passed");
  if (condition.kind === "pr-merged") {
    const timeoutSec = secondsLeft(bound);
    const read = await readPrLiveness(String(condition.pr), {
      cwd: input.checkout,
      env: ghRepoEnvFor(input.slug),
      repository: input.slug,
      caller: "dispatch-pickup-condition",
      ...(timeoutSec === undefined ? {} : { timeoutSec }),
    });
    if (!read.ok)
      return read.failure === undefined
        ? failed("unreadable", read.reason)
        : failedBy("unreadable", read.failure, read.reason);
    return ok(
      ({ OPEN: "open", MERGED: "cleared", CLOSED: "closed-unmerged" } as const)[
        read.state
      ],
    );
  }
  try {
    if (input.tracker.dependencyState === undefined)
      return failed("unreadable", "the tracker does not expose item state");
    const state = await within(
      input.tracker.dependencyState(condition.item, bound.signal),
      bound,
    );
    return state === null
      ? failed("unreadable", "the tracker did not find the dependency")
      : ok(state === "closed" ? "cleared" : "open");
  } catch (error) {
    if (error instanceof Defect) throw error;
    return failed("unreadable", failureText(error), error);
  }
}

/** Try the tracker relation once it can be read. The local hold also covers a tracker that cannot write the relation. */
async function linkBlocker(
  hold: PersonPickupHold,
  input: Pick<ConditionRead, "tracker" | "slug" | "root" | "bound">,
): Promise<void> {
  const { condition } = hold;
  if (hold.relationSettled === true || condition?.kind !== "item-closed")
    return;
  const bound = facetBound(input.bound?.deadline);
  if (ended(bound)) return;
  try {
    await within(
      input.tracker.relate(condition.item, "blocks", hold.item, bound.signal),
      bound,
    );
  } catch (error) {
    swallow(
      error,
      `the native pickup blocker could not be set on ${hold.item}`,
    );
    // A permanently unsupported write still has the dispatcher's hold.
    if (POLICIES[failureOf(error).code].clearsByWaiting) return;
  }
  settlePickupHold(input.slug, hold, input.root, "relation-settled");
}

export async function readPickupConditions(
  holds: PersonPickupHold[],
  input: ConditionRead,
  report: RepoReport,
): Promise<{ holds: PersonPickupHold[]; blockers: PersonPickupHold[] }> {
  const read = new Map<string, ConditionObservation>();
  const current: PersonPickupHold[] = [];
  const blockers: PersonPickupHold[] = [];
  for (const hold of holds) {
    const { condition } = hold;
    if (
      hold.settled === "cleared" &&
      input.apply &&
      launchedAfter(hold, input)
    ) {
      settlePickupHold(input.slug, hold, input.root, "remove");
      const replacement = currentHold(input, hold.item, report);
      if (!replacement.ok) current.push(hold);
      else if (replacement.value !== null) current.push(replacement.value);
      continue;
    }
    if (condition === undefined || hold.settled !== undefined) {
      current.push(hold);
      continue;
    }
    const key = JSON.stringify(condition);
    const state = read.get(key) ?? (await conditionState(condition, input));
    read.set(key, state);
    if (
      state.ok &&
      state.value === "open" &&
      condition.kind === "item-closed" &&
      hold.relationSettled !== true
    )
      blockers.push(hold);
    const settled = settleCondition(hold, state, input, report);
    if (settled !== null) current.push(settled);
  }
  return { holds: current, blockers };
}

function settleCondition(
  hold: PersonPickupHold,
  observation: ConditionObservation,
  input: ConditionRead,
  report: RepoReport,
): PersonPickupHold | null {
  if (!observation.ok) {
    const { failure } = observation;
    if (hold.condition !== undefined) {
      const classified = readFailureOf(failure);
      if (failure.cause !== undefined)
        swallow(
          failure.cause,
          `keeping ${hold.item}'s pickup hold after an unreadable dependency`,
        );
      report.records.push({
        record: hold.condition.kind === "pr-merged" ? "forge" : "tracker",
        source: input.slug,
        ok: false,
        detail: `could not check ${hold.item}'s wait for ${pickupConditionWords(hold.condition)}: ${failure.reason}`,
        ...(classified === undefined ? {} : { failure: classified }),
      });
    }
    return hold;
  }
  const state = observation.value;
  if (!input.apply || (state !== "cleared" && state !== "closed-unmerged"))
    return hold;
  const remove =
    state === "cleared" &&
    hold.resumeRecord === undefined &&
    !pickupRecordsFor(hold, input).some(({ record }) =>
      holdsItem(record, hold.item),
    );
  if (settlePickupHold(input.slug, hold, input.root, remove ? "remove" : state))
    return remove ? null : { ...hold, settled: state };
  const replacement = currentHold(input, hold.item, report);
  return replacement.ok ? replacement.value : hold;
}

function currentHold(
  input: Pick<ConditionRead, "slug" | "root">,
  item: string,
  report: RepoReport,
) {
  const reading = personPickupHolds(input.slug, input.root);
  if (!reading.ok) {
    if (reading.failure.cause !== undefined)
      swallow(reading.failure.cause, `could not re-read ${item}'s pickup hold`);
    report.records.push({
      record: "runtime",
      source: input.slug,
      ok: false,
      detail: `could not re-read ${item}'s pickup hold: ${reading.failure.reason}`,
    });
  }
  return reading.ok
    ? ok(reading.value.find((hold) => hold.item === item) ?? null)
    : reading;
}

function launchedAfter(hold: PersonPickupHold, input: ConditionRead): boolean {
  return pickupRecordsFor(hold, input).some(
    ({ record }) => holdsItem(record, hold.item) && record.createdAt > hold.at,
  );
}

function pickupRecordsFor(hold: PersonPickupHold, input: ConditionRead) {
  return input.records.filter(
    ({ record }) =>
      record.repo === input.slug &&
      record.action === "pickup" &&
      pickupItems(record).includes(hold.item),
  );
}

/** An owning, applied tick records native blocker links, separate from reading queue facts. */
export async function linkPickupConditions(
  blockers: readonly PersonPickupHold[],
  input: Pick<ConditionRead, "tracker" | "slug" | "root" | "bound">,
  report: RepoReport,
): Promise<void> {
  for (const hold of blockers) {
    const current = currentHold(input, hold.item, report);
    if (
      current.ok &&
      current.value?.at === hold.at &&
      current.value.settled === undefined
    )
      await linkBlocker(current.value, input);
  }
}
