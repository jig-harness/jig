/**
 * The facets' closed lists (`facet-values.ts`) are the ones the code reads:
 * reading `issue_tracker.facets` holds and refuses each adapter's stores as
 * `ADAPTER_FACET_STORES` says, in its words, and the priorities' names and
 * numbers are `PRIORITIES`'.
 */
import { describe, expect, it } from "bun:test";
import { parseFacetEntries } from "../scripts/lib/tracker/facets/config.ts";
import {
  ADAPTER_FACET_STORES,
  FACET_STORES,
  FACET_TABLE,
  NO_PRIORITY,
  PRIORITIES,
  PRIORITY_NAMES,
} from "../scripts/lib/tracker/facets/facet-values.ts";
import {
  priorityName,
  priorityNumber,
} from "../scripts/lib/tracker/facets/values.ts";
import { FACETS, type Facet } from "../scripts/lib/tracker/port.ts";

type Store = keyof typeof FACET_STORES;
const STORES = Object.keys(FACET_STORES) as Store[];

/** The smallest entry naming `store` for `facet` that reading takes on every adapter. */
function entry(facet: Facet, store: Store): Record<string, unknown> {
  if (store === "field") return { store, field: "Some field" };
  if (store === "label" && facet === "priority")
    return { store, prefix: "prio:" };
  return { store };
}

const parse = (adapter: string, facet: Facet, store: Store) => () =>
  parseFacetEntries({ [facet]: entry(facet, store) }, adapter);

describe("the stores each adapter holds", () => {
  const cells = Object.entries(ADAPTER_FACET_STORES).flatMap(
    ([adapter, facets]) =>
      FACETS.flatMap((facet) =>
        STORES.map((store) => ({
          adapter,
          facet,
          store,
          cell: facets[facet][store],
          held: STORES.filter((s) => facets[facet][s].held),
        })),
      ),
  );

  it("lists every facet and every store for each adapter", () => {
    expect(Object.keys(FACET_TABLE)).toEqual([...FACETS]);
    for (const facets of Object.values(ADAPTER_FACET_STORES))
      for (const facet of FACETS)
        expect(Object.keys(facets[facet])).toEqual(STORES);
  });

  it.each(cells.filter((c) => c.cell.held))(
    "reading takes $adapter's $store store for $facet",
    ({ adapter, facet, store }) => {
      expect(parse(adapter, facet, store)()[facet]?.store).toBe(store);
    },
  );

  it.each(cells.filter((c) => !c.cell.held))(
    "reading refuses $adapter's $store store for $facet, in the table's words",
    ({ adapter, facet, store, cell, held }) => {
      expect(parse(adapter, facet, store)).toThrow(
        `the ${adapter} adapter cannot keep ${facet} in a ${store} store (${cell.meaning}); it keeps ${facet} in ${held.join(" or ")}`,
      );
    },
  );

  it("refuses a store the table does not list, naming the ones it does", () => {
    expect(() =>
      parseFacetEntries({ type: { store: "command" } }, "github"),
    ).toThrow(`must be one of ${STORES.join(", ")}`);
  });
});

describe("the priorities", () => {
  it("names each number as PRIORITIES does, and none for 0", () => {
    for (const name of PRIORITY_NAMES) {
      expect(priorityNumber(name)).toBe(PRIORITIES[name].number);
      expect(priorityName(PRIORITIES[name].number)).toBe(name);
    }
    expect(Object.keys(PRIORITIES)).toEqual([...PRIORITY_NAMES]);
    expect(priorityName(NO_PRIORITY.number)).toBeNull();
    expect(PRIORITY_NAMES.map((p) => PRIORITIES[p].number)).toEqual([
      1, 2, 3, 4,
    ]);
  });
});
