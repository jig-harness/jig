/**
 * Who assigned an item, kept between ticks where the tracker reads it in two
 * parts (`DispatchSource.assignmentActor` and `writeAccess`):
 *
 * - **The assignment's maker** is kept by the item's update time, which an
 *   assignment changes, under the tracker scope, the credential, the item
 *   and the assignee. A definite answer that no user made it
 *   (`AssignerUnknown`) is kept the same way, and answered as a failure
 *   with the code `assigner-unknown`. An item with no update time is read
 *   every time.
 * - **Whether that person may start work** is kept per person and
 *   credential for `WRITE_ACCESS_MS`, since losing write access changes no
 *   item; the reads of one person in flight at once are one read.
 *
 * A failed read is never kept. A tracker that reads the two together is
 * asked `assignedBy` as before. Every read just before a launch asks the
 * tracker again, whatever is kept here (`freshPickup`, `served-authority.ts`).
 *
 * Costs, on GitHub: nothing for an unchanged item; one `TrackerAssignedBy`
 * query (1 point) for an item whose update time moved; one
 * `TrackerCollaborator` query (1 point) per assigner and credential every
 * `WRITE_ACCESS_MS` at most.
 */
import { cacheByVersion } from "../../../shared/outbound/cache.ts";
import { coalesce } from "../../../shared/outbound/coalesce.ts";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { currentMs } from "../../../shared/time.ts";
import { failureText } from "../text.ts";
import { AssignerUnknown } from "../../../skills/do-item/scripts/lib/tracker/assigner-unknown.ts";
import type {
  Assigner,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
import { trackerScope } from "./served-reads.ts";

/** How long a person's write access, once read, stands for every item they assigned. */
export const WRITE_ACCESS_MS = 15 * 60_000;

type Actor = { id: string; name: string };
type KeptActor = { actor: Actor } | { unknown: string };

/** The write-access reads in flight, by key: items read at once share one. */
const asking = new Map<string, Promise<unknown>>();

/** Each tracker's credential identity, read once per opened tracker. */
const credentials = new WeakMap<Tracker, Promise<string>>();

function credentialOf(tracker: Tracker, signal?: AbortSignal): Promise<string> {
  const source = tracker.dispatchSource;
  if (source === undefined) return Promise.resolve("");
  let held = credentials.get(tracker);
  if (held === undefined) {
    held = source.credential(signal === undefined ? undefined : { signal });
    credentials.set(tracker, held);
    held.catch(() => credentials.delete(tracker));
  }
  return held;
}

function keptAccess(value: unknown, now: number): boolean | null {
  if (typeof value !== "object" || value === null) return null;
  const { at, trusted } = value as { at?: unknown; trusted?: unknown };
  return typeof at === "number" &&
    typeof trusted === "boolean" &&
    at <= now &&
    now - at < WRITE_ACCESS_MS
    ? trusted
    : null;
}

async function writeAccess(
  read: (person: string, signal?: AbortSignal) => Promise<boolean>,
  person: string,
  scope: string,
  cache: PickupReads,
  signal?: AbortSignal,
): Promise<boolean> {
  const key = `${scope}:write-access:${person.toLowerCase()}`;
  const kept = keptAccess(cache.get<unknown>(key), currentMs());
  if (kept !== null) return kept;
  return coalesce(asking, key, async () => {
    try {
      const trusted = await read(person, signal);
      cache.set(key, { at: currentMs(), trusted });
      return trusted;
    } finally {
      asking.delete(key);
    }
  });
}

/** A definite answer that no user made the assignment, as `AssignerUnknown` carries it. */
async function knownAssigner(
  read: () => Promise<Assigner>,
): Promise<KeptAssigner> {
  try {
    return ok(await read());
  } catch (error) {
    if (error instanceof AssignerUnknown)
      return failed("assigner-unknown", failureText(error));
    throw error;
  }
}

/** The assigner, or the definite answer that no user made the assignment. */
export type KeptAssigner = Outcome<Assigner, "assigner-unknown">;

/**
 * Who made the assignment of `identity` to `issue`, and whether they may
 * start work, from what `cache` keeps where it still stands; the definite
 * answer that no user made it as a failure, and any other failed read
 * thrown as `Tracker.assignedBy` throws it.
 */
export async function keptAssignedBy(
  tracker: Tracker,
  issue: PoolIssue,
  identity: string | undefined,
  cache: PickupReads,
  signal?: AbortSignal,
): Promise<KeptAssigner> {
  const source = tracker.dispatchSource;
  const actorOf = source?.assignmentActor;
  const accessOf = source?.writeAccess;
  if (actorOf === undefined || accessOf === undefined)
    return knownAssigner(() =>
      tracker.assignedBy(issue.identifier, identity, signal),
    );
  const options = signal === undefined ? undefined : { signal };
  const scope = `${trackerScope(tracker)}:${await credentialOf(tracker, signal)}`;
  const kept = await cacheByVersion<KeptActor>(
    cache,
    `${scope}:assigner:${issue.identifier}:${identity ?? ""}`,
    issue.updatedAt,
    async () => {
      const read = await knownAssigner(async () => ({
        ...(await actorOf(issue.identifier, identity, options)),
        trusted: false,
      }));
      return read.ok
        ? { actor: { id: read.value.id, name: read.value.name } }
        : { unknown: read.failure.reason };
    },
  );
  if ("unknown" in kept) return failed("assigner-unknown", kept.unknown);
  const trusted = await writeAccess(
    (person, s) =>
      accessOf(person, s === undefined ? undefined : { signal: s }),
    kept.actor.id,
    scope,
    cache,
    signal,
  );
  return ok({ ...kept.actor, trusted });
}
