/** Shared native tracker rows, interpreted anew by each repository. */
import type {
  DispatchRawIssue,
  PoolIssue,
  QueueIssue,
  QueueParent,
  Tracker,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import {
  isWorkingIssue,
  trackerStateMaps,
} from "../../../skills/do-item/scripts/lib/tracker/port.ts";
import type { PickupReads } from "../pickup-reads.ts";
import type { ServedView, ServedViews, HeldIssue } from "./served-reads.ts";

import { isRateLimited } from "../../../shared/tracker-budget.ts";
import { failureText } from "../text.ts";
import { nativeFacts } from "./native-facts.ts";
import { ended, within } from "./bounded.ts";
import type { FacetBound } from "./tracker-facets.ts";

type NativePool = PoolIssue & { nativeRow: DispatchRawIssue };

const scopeReads = new WeakMap<
  ServedViews,
  Map<string, Map<string, Promise<unknown>>>
>();
function sharedReads(
  views: ServedViews | undefined,
  key: string,
): Map<string, Promise<unknown>> {
  if (views === undefined) return new Map();
  let scopes = scopeReads.get(views);
  if (scopes === undefined) {
    scopes = new Map();
    scopeReads.set(views, scopes);
  }
  let reads = scopes.get(key);
  if (reads === undefined) {
    reads = new Map();
    scopes.set(key, reads);
  }
  return reads;
}

/** A carrier only: repository state and facet values are never stored in this row. */
function carrier(row: DispatchRawIssue): NativePool {
  return {
    identifier: row.identifier,
    title: "",
    url: null,
    createdAt: "",
    priority: 0,
    type: null,
    size: null,
    isEpic: false,
    hasOpenChildren: false,
    labels: [],
    truncated: [],
    assignee: null,
    state: { id: "", name: "", type: "" },
    nativeRow: row,
  };
}
function queued(row: DispatchRawIssue): QueueIssue {
  return {
    ...carrier(row),
    relations: row.relations ?? null,
    parent:
      row.parent == null
        ? null
        : { ...row.parent, issue: carrier(row.parent.issue) },
  };
}

/** One credential-isolated reading, with no repository state or facet configuration in its key. */
export async function nativeSharedView(
  views: ServedViews | undefined,
  tracker: Tracker,
  identity: string,
  options: {
    nowMs: number;
    headroom: boolean;
    bound?: FacetBound;
    scopeIdentities?: readonly string[];
  },
  cache: PickupReads,
  engine: {
    open: (
      tracker: Tracker,
      identity: string,
      options: { nowMs: number; headroom: boolean; bound?: FacetBound },
      cache: PickupReads,
      shape?: string,
    ) => Promise<ServedView>;
    probe: (
      tracker: Tracker,
      identity: string,
      cache: PickupReads,
    ) => { since: string; keys: string[] } | null;
    credential: (tracker: Tracker, credential: string) => void;
  },
): Promise<ServedView> {
  if (ended(options.bound))
    return Promise.reject(new Error("stopped at the tick’s deadline"));
  const source = tracker.dispatchSource;
  if (source === undefined)
    return Promise.reject(
      new Error("the tracker has no native dispatch source"),
    );
  const changedSince = tracker.changedSince;
  const credentialRead = source.credential(options.bound);
  const credential = await (options.bound === undefined
    ? credentialRead
    : within(credentialRead, options.bound));
  engine.credential(tracker, credential);
  const scope = `${tracker.adapter}:${tracker.instance ?? ""}:${tracker.team}:${credential}`;
  const reads = sharedReads(views, scope);
  source.shareReads?.(reads);
  const facts = nativeFacts(source, reads, options.bound);
  const key = `${scope}:${identity}`;
  let opening = views?.get(key);
  if (opening === undefined) {
    const nativeTracker: Tracker = {
      ...tracker,
      ...(changedSince === undefined
        ? {}
        : {
            changedSince: async (query) => {
              const identities = options.scopeIdentities ?? [identity];
              const saved = identities
                .map((person) => engine.probe(nativeTracker, person, cache))
                .filter((value) => value !== null);
              const since =
                [query.since, ...saved.map((value) => value.since)].sort(
                  (a, b) => a.localeCompare(b),
                )[0] ?? query.since;
              const keys = [
                ...new Set([
                  ...query.keys,
                  ...saved.flatMap((value) => value.keys),
                ]),
              ];
              const probeKey = `dispatch scope probe ${options.nowMs}`;
              let probe = reads.get(probeKey);
              if (probe === undefined) {
                probe = facts.guarded(() =>
                  changedSince(
                    { ...query, since, keys, identities },
                    options.bound?.signal,
                  ),
                );
                reads.set(probeKey, probe);
              }
              return (await probe) as import("../../../skills/do-item/scripts/lib/tracker/port.ts").ChangeAnswer;
            },
          }),
      configKey: `native-v1:${credential}`,
      stateName: () => null,
      stateMaps: () => [],
      queueIssues: async () => (await facts.queue(identity)).map(queued),
      poolIssue: async (key) => {
        const row = await facts.issue(key);
        return row === null ? null : carrier(row);
      },
      poolIssues: async (keys) =>
        new Map(
          await Promise.all(
            keys.map(async (key) => {
              const row = await facts.issue(key);
              return [key, row === null ? null : carrier(row)] as const;
            }),
          ),
        ),
      queueIssuesByKey: async (keys) =>
        new Map(
          [...(await facts.issues(keys))].map(([key, row]) => [
            key,
            queued(row),
          ]),
        ),
    };
    opening = engine.open(
      nativeTracker,
      identity,
      // The shared snapshot must not retain one repository's read allowance.
      // Each caller applies its own bound while awaiting or projecting it.
      { nowMs: options.nowMs, headroom: options.headroom },
      cache,
      source.shape,
    );
    views?.set(key, opening);
  }
  const native = await (options.bound === undefined
    ? opening
    : within(opening, options.bound));
  const projected = new Map<string, PoolIssue>();
  const parents = new Map<string, QueueParent>();
  const held = new Map<string, HeldIssue>();
  const project = async (value: PoolIssue): Promise<PoolIssue> => {
    const previous = projected.get(value.identifier);
    if (previous !== undefined) return previous;
    const raw = (value as NativePool).nativeRow;
    if (ended(options.bound))
      return Promise.reject(new Error("stopped at the tick’s deadline"));
    const read = source.project(raw, options.bound);
    const issue = await (options.bound === undefined
      ? read
      : within(read, options.bound));
    projected.set(issue.identifier, issue);
    if (raw.parent) {
      const parent = await project(carrier(raw.parent.issue));
      parents.set(parent.identifier, { ...raw.parent, issue: parent });
    }
    held.set(issue.identifier, {
      issue,
      relations: raw.relations ?? null,
      parent:
        raw.parent == null
          ? raw.parent
          : parents.get(raw.parent.issue.identifier),
    });
    return issue;
  };
  const queue = [...native.open().map((h) => h.issue), ...native.progress()];
  const projectedRows = async () => {
    const included = await Promise.all(
      queue.map(
        async (row) =>
          source.includes === undefined ||
          (await source.includes((row as NativePool).nativeRow, options.bound)),
      ),
    );
    return await Promise.all(queue.filter((_, i) => included[i]).map(project));
  };
  const rows = await projectedRows().catch((error) => {
    // A kept native reading still has an age even when an offline scope cannot supply store metadata.
    if (
      native.unavailable !== undefined ||
      native.limited !== null ||
      facts.failure() !== null
    )
      return [];
    return Promise.reject(error);
  });
  const maps = trackerStateMaps(tracker);
  const inQueue = (i: PoolIssue) =>
    ["triage", "backlog", "todo", "blocked"].some((state) =>
      maps.some(
        (map) =>
          map[state as "todo"] !== null &&
          map[state as "todo"]?.trim().toLowerCase() ===
            i.state.name.trim().toLowerCase(),
      ),
    );
  const open = rows
    .filter((i) => !isWorkingIssue(tracker, i) && inQueue(i))
    .map(
      (i) =>
        held.get(i.identifier) ?? {
          issue: i,
          relations: null,
          parent: undefined,
        },
    );
  const progress = rows.filter((i) => isWorkingIssue(tracker, i));
  return {
    ...native,
    scope,
    get limited() {
      const failure = facts.failure();
      return native.limited ?? (isRateLimited(failure) ? failure : null);
    },
    get unavailable() {
      const failure = facts.failure();
      return (
        native.unavailable ??
        (failure === null || isRateLimited(failure)
          ? undefined
          : failureText(failure))
      );
    },
    all: () => rows,
    once: (key, read) => facts.once(key, () => native.once(key, read)),
    open: () => open,
    progress: () => progress,
    raw: async (key) => {
      const row = await native.pool(key);
      return row === null ? null : (row as NativePool).nativeRow;
    },
    pool: async (key) => {
      const row = await native.pool(key);
      return row === null ? null : project(row);
    },
    held: (key) => held.get(key),
    parentBody: (key) => parents.get(key),
  };
}
