/**
 * An in-memory repository of issues, read and written through trackers made
 * by the real `withFacets`: each view keeps every facet its section names in
 * labels through the shared label store, and every other in the issue's own
 * fields, as an adapter's core would. Two views over one repository are the
 * source and the destination of a move.
 */

import {
  facetInputs,
  parseTrackerConfig,
} from "../../do-item/scripts/lib/tracker/config.ts";
import {
  type FacetEntries,
  type Facets,
  type ResolvedFacet,
  resolveFacets,
  usable,
} from "../../do-item/scripts/lib/tracker/facets/config.ts";
import {
  type CorePoolIssue,
  type CoreTracker,
  withFacets,
} from "../../do-item/scripts/lib/tracker/facets/tracker.ts";
import {
  FACETS,
  type Facet,
  type IssuePatch,
  type Tracker,
} from "../../do-item/scripts/lib/tracker/port.ts";
import type { Clock } from "../scripts/lib/pace.ts";

const TAXONOMY = {
  types: ["bug", "feature", "docs", "chore", "infra"],
  sizes: ["xs", "small", "medium", "large", "xl"],
};

export type State = "triage" | "backlog" | "unstarted" | "started" | "closed";

export interface FakeIssue {
  key: string;
  state: State;
  createdAt: string;
  labels: string[];
  /** The issue's own fields: an issue type, a priority number, a field option. */
  native: Partial<Record<Facet, string | number>>;
  comments: string[];
}

/** One write a view sent, by kind and issue. */
export interface Write {
  kind: "update" | "comment" | "transition";
  key: string;
  patch?: IssuePatch;
}

/** The facets of a GitHub repository with Jig's taxonomy and `section`. */
export function facetsFor(section: FacetEntries): Facets {
  return resolveFacets(
    facetInputs(
      parseTrackerConfig({
        issue_tracker: { adapter: "github", facets: section },
      }),
    ),
    { path: "label-taxonomy.yaml", ...TAXONOMY },
  );
}

export const LABEL_SECTION: FacetEntries = {
  type: { store: "label" },
  priority: { store: "label" },
  size: { store: "label" },
};

export const NATIVE_SECTION: FacetEntries = {
  type: { store: "native" },
  priority: { store: "native" },
  size: { store: "field", field: "Effort" },
};

export class FakeRepo {
  readonly issues: FakeIssue[] = [];
  readonly writes: Write[] = [];
  /** Answers each write: an error refuses it, `null` lets it through. */
  refuse: (w: Write) => Error | null = () => null;

  add(key: string, over: Partial<Omit<FakeIssue, "key">> = {}): FakeIssue {
    const issue: FakeIssue = {
      key,
      state: "backlog",
      createdAt: `2026-01-${String(this.issues.length + 1).padStart(2, "0")}T00:00:00Z`,
      labels: [],
      native: {},
      comments: [],
      ...over,
    };
    this.issues.push(issue);
    return issue;
  }

  get(key: string): FakeIssue {
    const found = this.issues.find((i) => i.key === key);
    if (found === undefined) throw new Error(`no issue ${key}`);
    return found;
  }

  private send(w: Write): void {
    const refused = this.refuse(w);
    if (refused !== null) throw refused;
    this.writes.push(w);
  }

  /**
   * A tracker keeping the facets where `section` says. With `hidePriority`,
   * a priority kept in its field leaves the `priority:` labels out of an
   * issue's labels, as the GitHub adapter does, and the open population
   * carries them apart.
   */
  view(
    section: FacetEntries,
    opts: { hidePriority?: boolean } = {},
  ): { tracker: Tracker; facets: Facets } {
    const facets = facetsFor(section);
    const own = new Set(
      FACETS.filter((f) => usable(facets[f]) && facets[f].store !== "label"),
    );
    const slot = (f: Facet) => facets[f] as ResolvedFacet;
    const hidden = (l: string) =>
      opts.hidePriority === true &&
      own.has("priority") &&
      l.startsWith("priority: ");
    const read = (i: FakeIssue): CorePoolIssue => {
      const nativeOf = (f: "type" | "size") => {
        const v = i.native[f];
        return own.has(f) && typeof v === "string"
          ? (slot(f).map?.fromTracker(v) ?? null)
          : null;
      };
      const p = i.native.priority;
      return {
        identifier: i.key,
        title: `title of ${i.key}`,
        url: null,
        priority: own.has("priority") && typeof p === "number" ? p : 0,
        ...(own.has("type") ? { type: nativeOf("type") } : {}),
        ...(own.has("size") ? { size: nativeOf("size") } : {}),
        createdAt: i.createdAt,
        state: { id: i.state, name: `state ${i.state}`, type: i.state },
        assignee: null,
        labels: i.labels.filter((l) => !hidden(l)),
        hasOpenChildren: false,
        truncated: [],
      };
    };
    const repo = this;
    const core = {
      adapter: "github",
      team: "owner/repo",
      stateName: (s: string) => s,
      async poolIssue(key: string) {
        return read(repo.get(key));
      },
      async getIssue(key: string) {
        return { ...read(repo.get(key)), description: "", nativeType: null };
      },
      async openPopulation() {
        return repo.issues
          .filter((i) => i.state !== "closed")
          .map((i) => {
            const kept = i.labels.filter(hidden);
            return kept.length === 0
              ? read(i)
              : { ...read(i), hiddenLabels: kept };
          });
      },
      async listComments(key: string) {
        return repo.get(key).comments.map((body) => ({ body }));
      },
      async postComment(key: string, body: string) {
        repo.send({ kind: "comment", key });
        repo.get(key).comments.push(body);
      },
      async transition(key: string, state: string) {
        repo.send({ kind: "transition", key });
        repo.get(key).state = state as State;
      },
      async updateIssue(key: string, patch: IssuePatch) {
        repo.send({ kind: "update", key, patch });
        const issue = repo.get(key);
        const remove = (patch.removeLabels ?? []).map((l) => l.toLowerCase());
        issue.labels = issue.labels.filter(
          (l) => !remove.includes(l.toLowerCase()),
        );
        for (const l of patch.addLabels ?? [])
          if (!issue.labels.includes(l)) issue.labels.push(l);
        for (const f of ["type", "size"] as const) {
          const v = patch[f];
          if (v === undefined || !own.has(f)) continue;
          if (v === null) delete issue.native[f];
          else issue.native[f] = slot(f).map?.toTracker(v) ?? v;
        }
        if (patch.priority !== undefined && own.has("priority")) {
          if (patch.priority === 0) delete issue.native.priority;
          else issue.native.priority = patch.priority;
        }
      },
    } as unknown as CoreTracker;
    return { tracker: withFacets(core, facets, own), facets };
  }
}

/** Jig's labels for an issue: a type, a priority and a size. */
export function labelled(
  type: string,
  priority: string,
  size?: string,
): string[] {
  return [
    type,
    `priority: ${priority}`,
    ...(size === undefined ? [] : [size]),
    "area:tracker",
  ];
}

/** A clock whose sleeps move its time on at once, recording each wait. */
export function fakeClock(): Clock & { slept: number[] } {
  let now = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}
