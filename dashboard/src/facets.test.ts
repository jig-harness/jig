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

test("a group card's selections on its targets' facts are met by one target", () => {
  const group = {
    text: "Group",
    values: {
      repo: ["org/a", "org/b"],
      age: ["Under 1 hour", "1 day or more"],
    },
    members: [
      { repo: ["org/a"], age: ["Under 1 hour"] },
      { repo: ["org/b"], age: ["1 day or more"] },
    ],
  };
  const filter = (repo: string, age: string) => ({
    query: "",
    values: { repo: [repo], age: [age] },
  });
  const facets = ["repo", "age"] as const;
  const match = (repo: string, age: string) =>
    projectFilters([group], filter(repo, age), facets).matching[0];
  // Each pair is held by one target, or by none.
  expect(match("org/a", "Under 1 hour")).toBe(true);
  expect(match("org/b", "1 day or more")).toBe(true);
  expect(match("org/a", "1 day or more")).toBe(false);
  expect(match("org/b", "Under 1 hour")).toBe(false);
  // The age chips count only ages a target in the selected repository holds.
  const counts = projectFilters(
    [group],
    { query: "", values: { repo: ["org/a"] } },
    facets,
  ).counts.age;
  expect(counts).toEqual([{ value: "Under 1 hour", count: 1 }]);
  const withAge = projectFilters(
    [group],
    { query: "", values: { repo: ["org/a"], age: ["Under 1 hour"] } },
    facets,
  ).counts.age;
  expect(withAge).toEqual([{ value: "Under 1 hour", count: 1 }]);
});
