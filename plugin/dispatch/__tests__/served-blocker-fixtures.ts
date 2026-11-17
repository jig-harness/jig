/** Shared tracker world for epic admission and blocker tests. */
import type {
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { TrackerRateLimited } from "../../shared/outbound/budget.ts";
import type { PickupReads } from "../lib/pickup-reads.ts";
import { readServedPickups } from "../lib/sources/served.ts";
import { issue } from "./served-fixtures.ts";
export const people = [
  { name: "Alex", forge: ["alex"], tracker: { github: "alex" } },
];

export const started = (
  key: string,
  assignee: string | null = null,
): PoolIssue => ({
  ...issue(key, [], assignee),
  state: { id: "s", name: "In Progress", type: "started" },
});

export interface Spec {
  /** What the served person is assigned. */
  assigned: PoolIssue[];
  /** Every other item a read can reach. */
  others?: PoolIssue[];
  /** `blocked_by` links: item to the items it waits on. */
  waits?: Record<string, string[]>;
  children?: Record<string, PoolIssue[]>;
  descriptions?: Record<string, string>;
  /** Items whose relations cannot be read. */
  failing?: string[];
  /** Items whose relation read meets a tracker rate limit. */
  limiting?: string[];
  /** Items whose relation read answers after the others. */
  slow?: string[];
}

export function world(spec: Spec) {
  const store = new Map<string, unknown>();
  const cache: PickupReads = {
    get: <T>(k: string) => (store.get(k) as T) ?? null,
    set: (k, v) => {
      store.set(k, v);
    },
  };
  const all = [
    ...spec.assigned,
    ...(spec.others ?? []),
    ...Object.values(spec.children ?? {}).flat(),
  ];
  const parent = new Map<string, string>();
  for (const [epic, kids] of Object.entries(spec.children ?? {}))
    for (const kid of kids) parent.set(kid.identifier, epic);
  const tracker = {
    adapter: "github",
    team: "example/repo",
    stateName: (state: string) => state,
    assignUnassigned: async () => ({ assigned: true }),
    assignedIssues: async (identity: string, states: string[]) =>
      states.includes("in_progress")
        ? []
        : spec.assigned.filter((i) => i.assignee?.name === identity),
    assignedBy: async () => ({ id: "writer", name: "writer", trusted: true }),
    openChildren: async (k: string) => spec.children?.[k] ?? [],
    listRelations: async (k: string) => [
      ...(spec.slow?.includes(k) ? await Bun.sleep(20).then(() => []) : []),
      ...(spec.limiting?.includes(k)
        ? (() => {
            throw new TrackerRateLimited("github", 60_000, "limited");
          })()
        : []),
      ...(spec.failing?.includes(k)
        ? (() => {
            throw new Error(`relations of ${k} cannot be read`);
          })()
        : []),
      ...(spec.waits?.[k] ?? []).map((i) => ({ type: "blocked_by", issue: i })),
      ...Object.entries(spec.waits ?? {})
        .filter(([, on]) => on.includes(k))
        .map(([i]) => ({ type: "blocks", issue: i })),
    ],
    poolIssue: async (k: string) => all.find((i) => i.identifier === k) ?? null,
    getIssue: async (k: string) => ({
      identifier: k,
      description: spec.descriptions?.[k] ?? "",
      parent: parent.has(k) ? { identifier: parent.get(k) } : null,
    }),
    user: async () => ({ id: "alex", name: "alex" }),
  } as unknown as Tracker;
  const read = (extra: Record<string, unknown> = {}) =>
    readServedPickups(tracker, people, {
      cache,
      nowMs: 1,
      headroom: true,
      ...extra,
    });
  return { tracker, read, cache };
}
