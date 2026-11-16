/**
 * The chapter on tracker facets, generated from the facets' closed lists in
 * `do-item`'s tracker (`facets/facet-values.ts`): the facets, the
 * priorities' numbers, the stores a facet may be kept in, the stores each
 * adapter holds, and why `facetStores` reports a store as the one in force.
 */
import {
  ADAPTER_FACET_STORES,
  type AdapterStoreCells,
  FACET_STORE_REASONS,
  FACET_STORES,
  FACET_TABLE,
  NO_PRIORITY,
  PRIORITIES,
} from "../../../plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts";
import type { Chapter, DataValue, FieldSpec, Scalar } from "../chapter.ts";
import { table } from "../markdown.ts";

const FILE = "plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts";

/** Entries of the tables this chapter leaves out: none. */
const EXCLUDED: readonly string[] = [];

/** How each adapter is named in a reader's words. */
const ADAPTER_TEXT: Readonly<Record<string, string>> = {
  github: "GitHub Issues",
  jira: "Jira",
  linear: "Linear",
};

interface Row {
  readonly entry: string;
  readonly value: DataValue;
}

const none = {
  number: null,
  adapter: null,
  facet: null,
  store: null,
  held: null,
};

const row = (
  entry: string,
  kind: string,
  name: string,
  meaning: string,
  extra: Readonly<Record<string, Scalar>> = {},
): Row => ({
  entry: `${FILE}#${entry}`,
  value: { kind, name, ...none, ...extra, meaning },
});

function rows(): Row[] {
  const facets = Object.entries(FACET_TABLE).map(([name, v]) =>
    row(`FACET_TABLE.${name}`, "facet", name, v.meaning),
  );
  const priorities = [
    row("NO_PRIORITY", "priority", "none", NO_PRIORITY.meaning, {
      number: NO_PRIORITY.number,
    }),
    ...Object.entries(PRIORITIES).map(([name, v]) =>
      row(`PRIORITIES.${name}`, "priority", name, v.meaning, {
        number: v.number,
      }),
    ),
  ];
  const stores = Object.entries(FACET_STORES).map(([name, v]) =>
    row(`FACET_STORES.${name}`, "store", name, v.meaning),
  );
  const cells: AdapterStoreCells = ADAPTER_FACET_STORES;
  const held = Object.entries(cells).flatMap(([adapter, byFacet]) =>
    Object.entries(byFacet).flatMap(([facet, byStore]) =>
      Object.entries(byStore).map(([store, v]) =>
        row(
          `ADAPTER_FACET_STORES.${adapter}.${facet}.${store}`,
          "adapter-store",
          `${adapter}:${facet}:${store}`,
          v.meaning,
          { adapter, facet, store, held: v.held },
        ),
      ),
    ),
  );
  const reasons = Object.entries(FACET_STORE_REASONS).map(([name, v]) =>
    row(`FACET_STORE_REASONS.${name}`, "reason", name, v.meaning),
  );
  return [...facets, ...priorities, ...stores, ...held, ...reasons].filter(
    (r) => !EXCLUDED.includes(r.entry),
  );
}

const of = (kind: string) =>
  rows()
    .map((r) => r.value)
    .filter((v) => v.kind === kind);

const named = (kind: string) => () =>
  table(
    [kind === "reason" ? "Why" : "Name", "Meaning"],
    of(kind).map((v) => [`\`${v.name}\``, String(v.meaning)]),
  );

function prioritiesTable(): string {
  return table(
    ["Number", "Configuration name", "Meaning"],
    of("priority").map((v) => [
      String(v.number),
      v.name === "none" ? "—" : `\`${v.name}\``,
      String(v.meaning),
    ]),
  );
}

function adapterStoresTable(): string {
  const stores = Object.keys(FACET_STORES);
  const cells = of("adapter-store");
  const pairs = [
    ...new Set(cells.map((v) => `${String(v.adapter)}:${String(v.facet)}`)),
  ];
  return table(
    ["Adapter", "Facet", ...stores.map((s) => `\`${s}\``)],
    pairs.map((pair) => {
      const [adapter, facet] = pair.split(":") as [string, string];
      return [
        `${ADAPTER_TEXT[adapter] ?? adapter} (\`${adapter}\`)`,
        `\`${facet}\``,
        ...stores.map((store) => {
          const v = cells.find((c) => c.name === `${pair}:${store}`);
          if (v === undefined) return "—";
          const text = String(v.meaning).replaceAll("<", "&lt;");
          return v.held ? text : `refused: ${text}`;
        }),
      ];
    }),
  );
}

const FIELDS: Readonly<Record<string, FieldSpec>> = {
  kind: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "facet for an issue facet, priority for a priority, store for a store a facet may be kept in, adapter-store for whether one adapter holds one store for one facet, reason for why facet-stores reports a store as the one in force.",
  },
  name: {
    type: "string",
    nullable: false,
    required: true,
    identifies: true,
    description:
      "The facet, the store or the reason as the interface and the configuration write it; a priority's configuration name, or none for priority 0; for an adapter-store, the adapter, the facet and the store, as <adapter>:<facet>:<store>.",
  },
  number: {
    type: "integer",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For a priority, the number the interface carries it as; null for every other kind.",
  },
  adapter: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For an adapter-store, the adapter as issue_tracker.adapter names it; null for every other kind.",
  },
  facet: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description: "For an adapter-store, the facet; null for every other kind.",
  },
  store: {
    type: "string",
    nullable: true,
    required: true,
    identifies: false,
    description: "For an adapter-store, the store; null for every other kind.",
  },
  held: {
    type: "boolean",
    nullable: true,
    required: true,
    identifies: false,
    description:
      "For an adapter-store, whether the adapter holds the store for the facet; a configuration that names a store it does not hold is refused. Null for every other kind.",
  },
  meaning: {
    type: "string",
    nullable: false,
    required: true,
    identifies: false,
    description:
      "What the facet, the priority, the store or the reason means; for an adapter-store, what the store is on that tracker where the adapter holds it, or why it is refused where it does not.",
  },
};

export const TRACKER_FACETS: Chapter = {
  id: "tracker-facets",
  title: "Tracker facets: type, priority and size",
  summary:
    "The facts every issue carries beside its labels, the numbers of the priorities, the stores a facet may be kept in and which each tracker adapter holds, and why a facet's store is the one in force.",
  version: 1,
  status: "provisional",
  planItems: [{ item: 41, epic: 518 }],
  module: "tools/protocol/chapters/tracker-facets.ts",
  sections: [
    { source: `${FILE}#FACET_TABLE`, render: named("facet") },
    { source: `${FILE}#PRIORITIES,NO_PRIORITY`, render: prioritiesTable },
    { source: `${FILE}#FACET_STORES`, render: named("store") },
    { source: `${FILE}#ADAPTER_FACET_STORES`, render: adapterStoresTable },
    { source: `${FILE}#FACET_STORE_REASONS`, render: named("reason") },
  ],
  fields: FIELDS,
  values: () => rows().map((r) => r.value),
  takes: () => rows().map((r) => r.entry),
  excluded: EXCLUDED,
};
