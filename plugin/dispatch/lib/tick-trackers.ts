/** Gather tracker queues before any repository derives its own pickups. */
import { openTracker } from "../../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type Tracker,
  type CanonicalState,
  workingStates,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { nativeQueueRequirements } from "../../skills/do-item/scripts/lib/tracker/dispatch-source.ts";
import { swallow } from "../../shared/errors.ts";
import { slotTable } from "./accounts.ts";
import { pickupReads } from "./pickup-reads.ts";
import { trackerConfigOf } from "./section.ts";
import { sharedView } from "./sources/served-reads.ts";
import { allRecords, tickDeadline, type TickContext } from "./tick-context.ts";
import { facetBound } from "./sources/tracker-facets.ts";
import type { OpenedRepo } from "./tick-observe.ts";

/** The same adapter serves preloading and the repository's later interpretation. */
function trackerFor(opened: OpenedRepo): Tracker {
  opened.tracker ??= openTracker(
    trackerConfigOf(opened.values, opened.repo.slug),
    opened.repo.path,
  );
  return opened.tracker;
}

/** Whether this tick has room for a pickup; no room allows a young kept reading to serve without a probe. */
function trackerHeadroom(context: TickContext): boolean {
  const machine = context.options.machine;
  return (
    machine == null ||
    slotTable(machine.accounts, allRecords(context), context.nowMs).some(
      (slot) =>
        slot.held < slot.account.maxPerAccount &&
        slot.wall === null &&
        !slot.wallUnrecorded,
    )
  );
}

/** The native state superset needed by this repository's factory, served queues and claim watch. */
function queueRequirements(
  repo: OpenedRepo,
  tracker: Tracker,
  served: boolean,
): string[] {
  const states = new Set<CanonicalState>(workingStates(tracker));
  if (repo.section.identity !== null)
    for (const state of repo.section.states)
      states.add(state as CanonicalState);
  if (served)
    for (const state of ["triage", "backlog", "todo", "blocked"] as const)
      states.add(state);
  return nativeQueueRequirements(tracker, [...states]);
}

/**
 * All configurations are in hand before any queue is opened. The shared
 * view groups by native tracker scope and person, keeping a rejected read
 * too so repository derivation never retries a failed scope in this tick.
 * Read failures are reported by each repository's normal tracker boundary.
 */
export async function prepareTrackers(
  opened: readonly OpenedRepo[],
  context: TickContext,
): Promise<void> {
  const bound = facetBound(tickDeadline(context).deadline);
  const needs = opened.flatMap((repo) => {
    try {
      const people = repo.stages.has("pickup")
        ? (context.options.machine?.serve ?? [])
        : [];
      if (people.length === 0 && repo.section.identity === null) return [];
      const tracker = trackerFor(repo);
      if (tracker.dispatchSource === undefined) return [];
      const identities = new Set(
        people.flatMap((person) =>
          Object.entries(person.tracker)
            .filter(([adapter]) => adapter === tracker.adapter)
            .map(([, identity]) => identity),
        ),
      );
      if (repo.section.identity !== null) identities.add(repo.section.identity);
      const requirements = queueRequirements(repo, tracker, people.length > 0);
      return [...identities].map((identity) => ({
        tracker,
        identity,
        requirements,
      }));
    } catch (error) {
      // The repository's tracker read reports a configuration it cannot open.
      swallow(
        error,
        "preload tracker configuration; the repository read reports the failure",
      );
      return [];
    }
  });
  const scopes = new Map<string, Tracker[]>();
  const grouped = await Promise.allSettled(
    needs.map(async ({ tracker }) => {
      const source = tracker.dispatchSource;
      if (source === undefined) return;
      const credential = await source.credential(bound);
      const key = JSON.stringify([
        tracker.adapter,
        tracker.instance ?? "",
        tracker.team,
        credential,
      ]);
      const members = scopes.get(key) ?? [];
      if (!members.includes(tracker)) members.push(tracker);
      scopes.set(key, members);
    }),
  );
  for (const result of grouped) {
    if (result.status === "rejected")
      swallow(
        result.reason,
        "group tracker scope; the repository read reports the failure",
      );
  }
  const scopeIdentities = new Map<Tracker, string[]>();
  for (const members of scopes.values()) {
    const reads = new Map<string, Promise<unknown>>();
    const identities = [
      ...new Set(
        needs
          .filter(({ tracker }) => members.includes(tracker))
          .map(({ identity }) => identity),
      ),
    ].sort((a, b) => a.localeCompare(b));
    const requirements = [
      ...new Set([
        ...members.flatMap(
          (tracker) => tracker.dispatchSource?.requirements ?? [],
        ),
        ...needs
          .filter(({ tracker }) => members.includes(tracker))
          .flatMap(({ requirements }) => requirements),
      ]),
    ].sort((a, b) => a.localeCompare(b));
    for (const tracker of members) {
      scopeIdentities.set(tracker, identities);
      tracker.dispatchSource?.configure?.(requirements);
      tracker.dispatchSource?.shareReads?.(reads);
    }
  }
  const headroom = trackerHeadroom(context);
  const readings = await Promise.allSettled(
    needs.map(({ tracker, identity }) =>
      context.reads.pool.run(() =>
        sharedView(
          context.reads.servedViews,
          tracker,
          identity,
          {
            nowMs: context.nowMs,
            headroom,
            bound,
            scopeIdentities: scopeIdentities.get(tracker) ?? [identity],
          },
          pickupReads,
        ),
      ),
    ),
  );
  for (const result of readings) {
    if (result.status === "rejected")
      swallow(
        result.reason,
        "preload tracker scope; the shared view retains the failed read",
      );
  }
}
