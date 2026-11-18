import type {
  QueueGroup,
  QueueSource,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { ViewId } from "./search.ts";

export const FACETS = [
  "act",
  "repo",
  "person",
  "stage",
  "age",
  "source",
  "kind",
  "happens",
] as const;
export type Facet = (typeof FACETS)[number];
export type FacetValues = Partial<Record<Facet, readonly string[]>>;

export interface CardFilter {
  query: string;
  values: FacetValues;
}

export const EMPTY_CARD_FILTER: CardFilter = { query: "", values: {} };

const PARAM: Record<Facet, string> = {
  act: "facet-act",
  repo: "facet-repo",
  person: "facet-person",
  stage: "facet-stage",
  age: "facet-age",
  source: "source",
  kind: "facet-kind",
  happens: "facet-happens",
};

export const CARD_FILTER_PARAMS = [
  "q",
  ...Object.values(PARAM),
  "facet-source",
];

function facetId(facet: Facet, value: string): string {
  return facet === "person" ? value.toLowerCase() : value;
}

export function readCardFilter(search: string): CardFilter {
  const params = new URLSearchParams(search);
  const values: FacetValues = {};
  for (const facet of FACETS) {
    const entries = params.getAll(PARAM[facet]);
    if (facet === "source") entries.push(...params.getAll("facet-source"));
    const distinct = [
      ...new Set(entries.filter(Boolean).map((value) => facetId(facet, value))),
    ];
    if (distinct.length > 0) values[facet] = distinct;
  }
  return { query: params.get("q") ?? "", values };
}

export function cardFilterPairs(filter: CardFilter): [string, string][] {
  const pairs: [string, string][] = filter.query ? [["q", filter.query]] : [];
  for (const facet of FACETS) {
    for (const value of filter.values[facet] ?? []) {
      pairs.push([PARAM[facet], value]);
    }
  }
  return pairs;
}

/** Which facets apply to the cards a view draws, including ones a link can carry. */
export function facetsFor(view: ViewId): readonly Facet[] {
  switch (view) {
    case "needs":
      return ["act", "repo", "person", "stage", "age"];
    case "merge":
    case "running":
      return ["repo"];
    case "queue":
      return ["repo", "source", "kind", "happens"];
    default:
      return [];
  }
}

/** What will happen to a queued target, in the order the dispatcher lists it. */
export const QUEUE_GROUPS = [
  "starts",
  "held",
  "reported",
  "never",
] as const satisfies readonly QueueGroup[];

export const QUEUE_SOURCES = [
  "re-armable",
  "label drive",
  "held",
  "assigned",
  "merged",
] as const satisfies readonly QueueSource[];

export const QUEUE_KINDS = ["pull request", "item"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];

/** The ways What is coming can be grouped; the first is the dispatcher's order. */
export const QUEUE_GROUPINGS = [
  { id: "group", word: "what happens" },
  { id: "repo", word: "repository" },
  { id: "source", word: "source" },
  { id: "none", word: "none" },
] as const;
export type QueueGrouping = (typeof QUEUE_GROUPINGS)[number]["id"];
export const DEFAULT_QUEUE_GROUPING: QueueGrouping = "group";

const QUEUE_OPTION_ORDER: Partial<Record<Facet, readonly string[]>> = {
  source: QUEUE_SOURCES,
  kind: QUEUE_KINDS,
  happens: QUEUE_GROUPS,
};

/**
 * A facet's options as its row lists them. The counts come in the cards' order,
 * which regrouping the queue changes, so the queue's rows keep an order of their
 * own and a chip stays where it was.
 */
export function orderedOptions(
  view: ViewId,
  facet: Facet,
  options: readonly FacetCount[],
): readonly FacetCount[] {
  if (view !== "queue") return options;
  const known = QUEUE_OPTION_ORDER[facet];
  if (known === undefined)
    return options.toSorted((a, b) => a.value.localeCompare(b.value));
  const rank = (value: string) => {
    const at = known.indexOf(value);
    return at === -1 ? known.length : at;
  };
  return options.toSorted((a, b) => rank(a.value) - rank(b.value));
}

export function facetAttrs(values: FacetValues): Record<string, string> {
  return Object.fromEntries(
    FACETS.flatMap((facet) =>
      values[facet]?.length
        ? [[`data-facet-${facet}`, JSON.stringify(values[facet])]]
        : [],
    ),
  );
}

export function readFacetAttrs(
  card: HTMLElement,
  facets: readonly Facet[],
): FacetValues {
  const values: FacetValues = {};
  for (const facet of facets) {
    const encoded = card.getAttribute(`data-facet-${facet}`);
    if (encoded === null) continue;
    const parsed: unknown = JSON.parse(encoded);
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === "string")
    )
      values[facet] = parsed;
  }
  return values;
}

export interface FacetCard {
  text: string;
  values: FacetValues;
}

export interface FacetCount {
  value: string;
  count: number;
}

export interface FilterProjection {
  matching: boolean[];
  counts: Partial<Record<Facet, FacetCount[]>>;
  active: boolean;
}

/** Count each candidate against the text and every other facet so its chip describes what it can add. */
export function projectFilters(
  cards: readonly FacetCard[],
  filter: CardFilter,
  facets: readonly Facet[],
): FilterProjection {
  const words = filter.query.toLowerCase().split(/\s+/).filter(Boolean);
  const active =
    words.length > 0 ||
    facets.some((facet) => Boolean(filter.values[facet]?.length));
  const counts: FilterProjection["counts"] = {};
  const byFacet = new Map(
    facets.map((facet) => [
      facet,
      new Map(
        (filter.values[facet] ?? []).map((value) => [facetId(facet, value), 0]),
      ),
    ]),
  );
  const matching = cards.map((card) => {
    const text = card.text.toLowerCase();
    const textMatches = words.every((word) => text.includes(word));
    const misses = facets.filter((facet) => {
      const selected = filter.values[facet] ?? [];
      return (
        selected.length > 0 &&
        !selected.some((value) =>
          card.values[facet]?.some(
            (option) => facetId(facet, value) === facetId(facet, option),
          ),
        )
      );
    });
    for (const [facet, options] of byFacet) {
      const reachable =
        textMatches &&
        (misses.length === 0 || (misses.length === 1 && misses[0] === facet));
      const ids = new Set(
        card.values[facet]?.map((value) => facetId(facet, value)),
      );
      for (const value of ids) {
        options.set(value, (options.get(value) ?? 0) + Number(reachable));
      }
    }
    return textMatches && misses.length === 0;
  });

  for (const [facet, options] of byFacet) {
    counts[facet] = [...options].map(([value, count]) => ({ value, count }));
  }
  return { matching, counts, active };
}
