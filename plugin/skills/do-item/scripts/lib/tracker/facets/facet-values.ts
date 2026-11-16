/**
 * The closed lists of the issue facets, each entry with what it means: the
 * facets, the priorities, the stores a facet may be kept in, the stores each
 * adapter holds per facet, and why `facetStores` reports a facet's store as
 * the one in force (design/tracker-facets.md in the Jig repository).
 *
 * The code reads its lists from these tables: `values.ts` its priorities,
 * `config.ts` the stores and what each adapter holds; the facets and the
 * reasons are typed against the interface's own (`port.ts`), so neither can
 * gain an entry the other lacks. The Jig Protocol's
 * chapter on tracker facets is generated from them
 * (`plugin/protocol/tracker-facets.md`).
 *
 * The type and size values are not listed here: they are the repository's
 * own, from its label taxonomy (or its work types, for a type).
 */
import type { Facet, FacetStoreKind, FacetStoreReport } from "../port.ts";

/** One entry of a list: what it means. */
export interface Meant {
  readonly meaning: string;
}

/** The facets, in the interface's order (`FACETS` in `port.ts`). */
export const FACET_TABLE = {
  type: {
    meaning:
      "What kind of work the issue is: a type of the repository's label taxonomy, or a work type where it has no taxonomy; null for none",
  },
  priority: {
    meaning:
      "How soon the issue matters: a number from 1 (urgent) to 4 (low), or 0 for none",
  },
  size: {
    meaning:
      "How much work the issue is: a label of the taxonomy's size group, null for none; a repository whose taxonomy has no size group has no size facet, and an epic is asked no size",
  },
} as const satisfies Record<Facet, Meant>;

/** The priorities, 1 (urgent) to 4 (low), by the names the configuration uses. */
export const PRIORITY_NAMES = ["urgent", "high", "medium", "low"] as const;
export type PriorityName = (typeof PRIORITY_NAMES)[number];

/** A priority's number on the interface, and what it means. */
export interface PrioritySpec extends Meant {
  readonly number: number;
}

/** Each priority the configuration names, with its number. */
export const PRIORITIES = {
  urgent: { number: 1, meaning: "The most pressing: before every other" },
  high: { number: 2, meaning: "Ahead of the usual run of work" },
  medium: { number: 3, meaning: "The usual run of work" },
  low: { number: 4, meaning: "Behind the usual run of work" },
} as const satisfies Record<PriorityName, PrioritySpec>;

/** No priority: the number an issue with none carries; the configuration has no name for it. */
export const NO_PRIORITY = {
  number: 0,
  meaning:
    "No priority: the issue is unranked, not low, so a pool that holds it cannot be worked in order; a filing through the tracker refuses it",
} as const satisfies PrioritySpec;

/** The stores a facet may be kept in (`issue_tracker.facets.<facet>.store`), in the order a refusal lists them. */
export const FACET_STORES = {
  native: {
    meaning:
      "The tracker's own field for the fact: an issue type, a priority field or an estimate, each canonical value kept as the tracker's value of its own name unless the entry's values map names another; the exceptions are Linear's priority, kept as its number from 1 to 4, and Linear's size, kept as the team's estimate scale",
  },
  field: {
    meaning:
      "A custom field the entry's field names, each canonical value kept as the option, text or number of its own name unless the entry's values map names another",
  },
  label: {
    meaning:
      "A label per value: the value's own name (on GitHub Issues, a priority's is priority: followed by it), unless the entry's labels map names each value's label or its prefix comes before the value",
  },
} as const satisfies Record<FacetStoreKind, Meant>;

/** Whether an adapter holds a store for a facet: what the store is there, or why it is refused. */
export interface StoreHold extends Meant {
  readonly held: boolean;
}

/** Each adapter's cells, by facet then by store, as a reader that names neither walks them. */
export type AdapterStoreCells = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, StoreHold>>>>>
>;

/**
 * For each adapter (`issue_tracker.adapter`), each facet and each store:
 * whether the adapter holds it in this release, and what it is there, or
 * the reason a configuration that names it is refused.
 */
export const ADAPTER_FACET_STORES = {
  github: {
    type: {
      native: { held: true, meaning: "The issue type" },
      field: {
        held: true,
        meaning: "An issue field of the repository's organization, by name",
      },
      label: { held: true, meaning: "A label per type" },
    },
    priority: {
      native: {
        held: true,
        meaning: "The organization's Priority issue field",
      },
      field: {
        held: true,
        meaning: "An issue field of the repository's organization, by name",
      },
      label: {
        held: true,
        meaning:
          "A label per priority, priority: urgent to priority: low unless issue_tracker.github.priority_labels or the entry's labels or prefix names them",
      },
    },
    size: {
      native: {
        held: false,
        meaning:
          "an Effort issue field is a field store (store: field, field: Effort)",
      },
      field: {
        held: true,
        meaning:
          "An issue field of the repository's organization, by name, such as Effort",
      },
      label: { held: true, meaning: "A label per size" },
    },
  },
  jira: {
    type: {
      native: { held: true, meaning: "The issue type" },
      field: {
        held: true,
        meaning: "A custom field of the site, by its name or its id",
      },
      label: { held: true, meaning: "A label per type" },
    },
    priority: {
      native: {
        held: true,
        meaning:
          "The priority field, each priority by the names issue_tracker.facets.priority.values or issue_tracker.jira.priorities gives it, else Highest, High, Medium and Low",
      },
      field: {
        held: false,
        meaning:
          "Jira keeps priority in its own priority field (store: native, with issue_tracker.jira.priorities)",
      },
      label: {
        held: true,
        meaning: "A label per priority, named by labels or a prefix",
      },
    },
    size: {
      native: {
        held: false,
        meaning:
          "each site's estimate is a custom field: store: field, field: <its name or id>",
      },
      field: {
        held: true,
        meaning: "A custom field of the site, by its name or its id",
      },
      label: { held: true, meaning: "A label per size" },
    },
  },
  linear: {
    type: {
      native: { held: false, meaning: "Linear has no issue types" },
      field: {
        held: false,
        meaning: "the Linear adapter has no custom field to name",
      },
      label: { held: true, meaning: "A label per type" },
    },
    priority: {
      native: { held: true, meaning: "The priority field" },
      field: {
        held: false,
        meaning: "the Linear adapter has no custom field to name",
      },
      label: {
        held: true,
        meaning: "A label per priority, named by labels or a prefix",
      },
    },
    size: {
      native: { held: true, meaning: "The team's estimate" },
      field: {
        held: false,
        meaning: "the Linear adapter has no custom field to name",
      },
      label: { held: true, meaning: "A label per size" },
    },
  },
} as const satisfies Record<
  string,
  Record<Facet, Record<FacetStoreKind, StoreHold>>
>;

/** Why `facetStores` reports a facet's store as the one in force (`FacetStoreReport.why`). */
export const FACET_STORE_REASONS = {
  configured: {
    meaning:
      "Named by issue_tracker.facets, or on Jira by an issue_tracker.jira.field_labels entry whose labels are the facet's values, which keeps the facet in that field",
  },
  "kept in labels": {
    meaning:
      "Kept in labels because a setting names the facet's labels (issue_tracker.types, issue_tracker.github.priority_labels) or, on GitHub Issues, an issue carries one",
  },
  detected: {
    meaning:
      "Selected on GitHub Issues from what detection read: an issue's value in the tracker's own field, or, with no labels or values at all, the field the organization has",
  },
  default: {
    meaning:
      "The adapter's default, with nothing named and nothing detected to move it. On GitHub Issues it is also the reason for a facet left to the default whose detection could choose no store (no answer, a failed read, a Priority field whose options do not name the priorities, values in the tracker's own field that cannot be read as the facet): store is then null, problem says why, and the facet's reads and writes fail until the configuration names a store",
  },
  conflict: {
    meaning:
      "The facet's labels and values in the tracker's own field are both present and no store is named: store is null, and the facet's reads and writes fail, naming both stores, until the configuration names one",
  },
  "no facet": {
    meaning:
      "The repository has no such facet, as size with no size group, or its taxonomy cannot be read: store is null",
  },
} as const satisfies Record<FacetStoreReport["why"], Meant>;
