import { expect, test } from "bun:test";
import {
  cardFilterPairs,
  facetsFor,
  orderedOptions,
  projectFilters,
  readCardFilter,
} from "./facets.ts";
import { pageQuery, readFilter } from "./search.ts";

test("text and facets intersect, while selections in one facet add alternatives", () => {
  const projection = projectFilters(
    [
      {
        text: "Update webhook",
        values: { act: ["Decide"], repo: ["org/api"] },
      },
      {
        text: "Update checkout",
        values: { act: ["Authorize"], repo: ["org/api"] },
      },
      {
        text: "Update checkout",
        values: { act: ["Investigate"], repo: ["org/api"] },
      },
      { text: "Update docs", values: { act: ["Decide"], repo: ["org/web"] } },
      {
        text: "Fix billing",
        values: { act: ["Authorize"], repo: ["org/api"] },
      },
    ],
    {
      query: "update",
      values: { act: ["Decide", "Authorize"], repo: ["org/api"] },
    },
    ["act", "repo"],
  );

  expect(projection.matching).toEqual([true, true, false, false, false]);
  expect(projection.counts).toEqual({
    act: [
      { value: "Decide", count: 1 },
      { value: "Authorize", count: 1 },
      { value: "Investigate", count: 1 },
    ],
    repo: [
      { value: "org/api", count: 2 },
      { value: "org/web", count: 1 },
    ],
  });
});

test("a view link round trips multiple facet values beside History's filters", () => {
  const original =
    "?view=queue&repo=org/history&facet-repo=org/api&facet-repo=org/web&source=assigned&q=update+billing";
  const cards = readCardFilter(pageQuery(readFilter(original), original));
  expect(cards).toEqual({
    query: "update billing",
    values: { repo: ["org/api", "org/web"], source: ["assigned"] },
  });
  expect(cardFilterPairs(cards)).toContainEqual(["source", "assigned"]);
  expect(facetsFor("queue")).toContain("source");
});

test("the queue's facets keep one order whichever way its cards are grouped", () => {
  const counts = (...values: string[]) =>
    values.map((value) => ({ value, count: 1 }));
  expect(facetsFor("queue")).toEqual(["repo", "source", "kind", "happens"]);
  expect(
    orderedOptions("queue", "happens", counts("never", "starts", "held")).map(
      (o) => o.value,
    ),
  ).toEqual(["starts", "held", "never"]);
  expect(
    orderedOptions("queue", "repo", counts("org/web", "org/api")).map(
      (o) => o.value,
    ),
  ).toEqual(["org/api", "org/web"]);
  expect(
    orderedOptions("needs", "repo", counts("org/web", "org/api")).map(
      (o) => o.value,
    ),
  ).toEqual(["org/web", "org/api"]);
});

test("the people facet unifies login casing in cards and shared links", () => {
  const filter = readCardFilter("?facet-person=Alice&facet-person=ALICE");
  const projection = projectFilters(
    [
      { text: "One", values: { person: ["Alice"] } },
      { text: "Two", values: { person: ["alice", "ALICE"] } },
    ],
    filter,
    ["person"],
  );
  expect(filter.values.person).toEqual(["alice"]);
  expect(projection.matching).toEqual([true, true]);
  expect(projection.counts.person).toEqual([{ value: "alice", count: 2 }]);
});
