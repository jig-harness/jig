/** Reuse the factory's bounded queue and provenance reads in the common walk. */
import type {
  Assigner,
  PoolIssue,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { ServedView } from "./served-reads.ts";
import type { FacetBound } from "./tracker-facets.ts";
import { ended, within } from "./bounded.ts";
import { OutboundError } from "../../../shared/outbound/failure.ts";
import { ok } from "../../../shared/outcome.ts";
import { currentMs } from "../../../shared/time.ts";

export function factoryWalkView(
  tracker: Tracker,
  identity: string,
  roots: PoolIssue[],
  progress: PoolIssue[],
  assigners: Map<string, Assigner>,
  bound?: FacetBound,
): ServedView {
  const pending = new Map<string, Promise<unknown>>();
  const all = new Map(
    [...roots, ...progress].map((issue) => [issue.identifier, issue]),
  );
  const held = roots.map((issue) => ({
    issue,
    relations: null,
    parent: undefined,
  }));
  for (const issue of roots) {
    const by = assigners.get(issue.identifier);
    if (by !== undefined)
      pending.set(
        `assignment ${issue.identifier} ${identity} ${issue.updatedAt ?? ""}`,
        // The answer `assigner-reads.ts` gives for this key.
        Promise.resolve(ok(by)),
      );
  }
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const previous = pending.get(key);
    if (previous !== undefined) return previous as Promise<T>;
    const answer = readWithin(read, bound);
    pending.set(key, answer);
    return answer;
  };
  return {
    source: "full",
    limited: null,
    readAt: currentMs(),
    ...(bound === undefined ? {} : { bound }),
    open: () => held,
    progress: () => progress,
    pool: (key) =>
      once(
        `pool ${key}`,
        async () => all.get(key) ?? (await tracker.poolIssue(key)),
      ),
    held: (key) => held.find((row) => row.issue.identifier === key),
    parentBody: () => undefined,
    once,
    save: () => {
      /* The factory reading is retained by its original reader. */
    },
  };
}

function readWithin<T>(read: () => Promise<T>, bound?: FacetBound): Promise<T> {
  if (ended(bound))
    return Promise.reject(
      new OutboundError("unreachable", "stopped at the tick's deadline"),
    );
  return bound === undefined ? read() : within(read(), bound);
}
