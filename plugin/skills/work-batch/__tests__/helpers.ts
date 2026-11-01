/**
 * Builders for the work-batch tests: a consumer configuration and catalog
 * held in memory, issues in the tracker interface's pool form, and an
 * in-memory tracker that answers the pool reads the way an adapter must
 * (open issues only, every label condition applied, an empty one refused).
 */
import {
  CLOSED_STATE_TYPES,
  type PoolIssue,
  type PoolQuery,
  type Tracker,
} from "../../do-item/scripts/lib/tracker/port.ts";
import {
  type ChangeAreaCatalog,
  parseCatalog,
} from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { type BatchPolicy, batchPolicy } from "../scripts/lib/policy.ts";

/** A repository that names its labels the way the defaults do, with every check on. */
export const OVERLAY: Record<string, unknown> = {
  issue_tracker: { adapter: "linear", team: "ENG" },
  review: {
    repo_label: "web",
    taxonomy: {
      repos: ["web", "api"],
      types: ["bug", "feature", "chore"],
      context_prefixes: ["area:", "domain:", "agent:"],
      ownership_prefixes: ["team:"],
    },
  },
  do_item: {
    agents: {
      codearea_areas: {
        "area:billing": "billing",
        "area:search": "search",
        "area:infra": "infra",
        "area:billing-api": "billing-api",
      },
    },
  },
  work_batch: { sizes: ["xs", "small", "medium", "large", "xl"] },
};

const CATALOG_YAML = {
  areas: {
    billing: {
      paths: ["src/billing/**"],
      tracker: { labels: ["area:billing", "domain:payments"] },
    },
    "billing-api": {
      paths: ["src/billing/api/**"],
      tracker: { labels: ["area:billing-api"], flags: ["api-review"] },
    },
    search: {
      paths: ["src/search/**"],
      tracker: { labels: ["area:search", "domain:payments"] },
    },
    infra: {
      paths: ["deploy/**"],
      tracker: { labels: ["area:infra"], flags: ["db-migration"] },
    },
    docs: {
      paths: ["docs/**"],
      tracker: { labels: ["domain:payments"] },
    },
  },
};

export function catalog(): ChangeAreaCatalog {
  return parseCatalog(CATALOG_YAML);
}

/** The policy of `OVERLAY` merged with `extra` one section deep, over the test catalog. */
export function policy(
  extra: Record<string, unknown> = {},
  cat: ChangeAreaCatalog | null = catalog(),
): BatchPolicy {
  return batchPolicy({ ...OVERLAY, ...extra }, cat);
}

let created = 0;

/**
 * An eligible small billing bug unless `over` says otherwise. Each issue is
 * created a minute after the one before, so "older" is the build order.
 */
export function issue(
  identifier: string,
  over: Partial<PoolIssue> = {},
): PoolIssue {
  created += 1;
  return {
    identifier,
    title: `Fix ${identifier}`,
    url: `https://tracker.example/${identifier}`,
    priority: 3,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, created)).toISOString(),
    state: { id: "state-backlog", name: "Backlog", type: "backlog" },
    assignee: null,
    labels: ["small", "web", "bug", "area:billing"],
    hasOpenChildren: false,
    truncated: [],
    ...over,
  };
}

/** `labels` with `drop` removed and `add` appended. */
export function relabel(
  labels: readonly string[],
  drop: readonly string[],
  add: readonly string[] = [],
): string[] {
  return [...labels.filter((l) => !drop.includes(l)), ...add];
}

export interface FakeTracker extends Tracker {
  /** Every pool query asked, in order. */
  readonly queries: PoolQuery[];
  /** Every child read asked, by key. */
  readonly childReads: string[];
}

function unsupported(name: string): () => never {
  return () => {
    throw new Error(`the batch proposal does not call ${name}`);
  };
}

/**
 * A tracker holding `issues` (and each epic's children in `children`).
 * `failGapRead` makes a read with `withNoneOf` throw, as a gap read the
 * tracker refuses would.
 */
export function fakeTracker(
  issues: readonly PoolIssue[],
  opts: {
    children?: Record<string, readonly PoolIssue[]>;
    failGapRead?: boolean;
  } = {},
): FakeTracker {
  const queries: PoolQuery[] = [];
  const childReads: string[] = [];
  const open = (i: PoolIssue) =>
    !(CLOSED_STATE_TYPES as readonly string[]).includes(i.state.type);
  return {
    adapter: "fake",
    team: "ENG",
    queries,
    childReads,
    stateName: (s) => s,
    reach: () => Promise.resolve(),
    getIssue: unsupported("getIssue"),
    listComments: unsupported("listComments"),
    listChildren: unsupported("listChildren"),
    transition: unsupported("transition"),
    postComment: unsupported("postComment"),
    issuesByKeys: unsupported("issuesByKeys"),
    issuesInWindow: unsupported("issuesInWindow"),
    startedIssueActivity: unsupported("startedIssueActivity"),
    commentsContaining: unsupported("commentsContaining"),
    issueComments: unsupported("issueComments"),
    ledger: unsupported("ledger"),
    labelledIssues: unsupported("labelledIssues"),
    createIssue: unsupported("createIssue"),
    updateIssue: unsupported("updateIssue"),
    listLabels: unsupported("listLabels"),
    searchIssues: unsupported("searchIssues"),
    listRelations: unsupported("listRelations"),
    relate: unsupported("relate"),
    assignedIssues: unsupported("assignedIssues"),
    assignedBy: unsupported("assignedBy"),
    viewer: unsupported("viewer"),
    assignees: unsupported("assignees"),
    assign: unsupported("assign"),
    async openIssues(query) {
      queries.push(query);
      if (
        query.withSomeOf.length === 0 ||
        query.withSomeOf.some((l) => l.length === 0)
      )
        throw new Error("a pool query needs a non-empty label list");
      if (opts.failGapRead && (query.withNoneOf?.length ?? 0) > 0)
        throw new Error("the tracker refused the gap read");
      return issues.filter(
        (i) =>
          open(i) &&
          query.withSomeOf.every((some) =>
            some.some((l) => i.labels.includes(l)),
          ) &&
          !(query.withNoneOf ?? []).some((l) => i.labels.includes(l)),
      );
    },
    async openChildren(key) {
      childReads.push(key);
      return (opts.children?.[key] ?? []).filter(open);
    },
    // Keys match whatever their case, as a tracker that accepts a typed key
    // does; the issue comes back with its own spelling.
    async poolIssue(key) {
      const same = (i: PoolIssue) =>
        i.identifier.toLowerCase() === key.toLowerCase();
      return (
        issues.find(same) ??
        Object.values(opts.children ?? {})
          .flat()
          .find(same) ??
        null
      );
    },
  };
}
