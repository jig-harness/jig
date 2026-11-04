import { describe, expect, it } from "bun:test";
import { TrackerConfigError } from "../scripts/lib/tracker/config-error.ts";
import { parseJiraSettings } from "../scripts/lib/tracker/jira/settings.ts";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import {
  type Call,
  issue,
  jira,
  jqlOf,
  page,
  routes,
  SITE,
  writes,
} from "./jira-fixtures.ts";

/** The site's fields, as `GET field` returns them. */
const SITE_FIELDS = [
  { id: "summary", name: "Summary", schema: { type: "string" } },
  {
    id: "customfield_10050",
    name: "Size",
    schema: { type: "option" },
  },
  {
    id: "customfield_10060",
    name: "Facets",
    schema: { type: "array", items: "option" },
  },
  {
    id: "customfield_10070",
    name: "Plan Anchor ID",
    schema: { type: "string" },
  },
  {
    id: "customfield_10080",
    name: "Story Points",
    schema: { type: "number" },
  },
  {
    id: "customfield_10090",
    name: "Driver",
    schema: { type: "user" },
  },
  { id: "customfield_10100", name: "Team", schema: { type: "option" } },
  { id: "customfield_10101", name: "Team", schema: { type: "option" } },
];

const FIELD_LABELS = {
  Size: "size:",
  customfield_10060: "facet:",
  "plan anchor id": "anchor:",
  "Story Points": "points:",
};

const overlay = (fieldLabels: Record<string, string> = FIELD_LABELS) => ({
  issue_tracker: { jira: { field_labels: fieldLabels } },
});

const fieldOf = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof TrackerConfigError
      ? e.field
      : `not a config error: ${String(e)}`;
  }
};

/** The error a promise rejects with. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const TAGGED = issue({
  key: "ENG-1",
  labels: ["a"],
  fields: {
    customfield_10050: { id: "1", value: "M" },
    customfield_10060: [{ value: "backend " }, { value: "ui" }],
    customfield_10070: "  WP-3 ",
    customfield_10080: 3,
  },
});

describe("issue_tracker.jira.field_labels", () => {
  it("maps each field, by name or id, to its prefix", () => {
    expect(
      parseJiraSettings({ site: SITE, field_labels: FIELD_LABELS }).fieldLabels,
    ).toEqual(FIELD_LABELS);
  });

  it("refuses a malformed mapping, naming the field", () => {
    const at = (v: unknown) =>
      fieldOf(() => parseJiraSettings({ site: SITE, field_labels: v }));
    expect(at(["Size"])).toBe("issue_tracker.jira.field_labels");
    expect(at({ Size: "" })).toBe("issue_tracker.jira.field_labels.Size");
    expect(at({ Size: "size of:" })).toBe(
      "issue_tracker.jira.field_labels.Size",
    );
    expect(at({ Size: "size:", size: "s:" })).toBe(
      "issue_tracker.jira.field_labels.size",
    );
    // A prefix that begins another leaves a label's field ambiguous.
    expect(at({ Size: "s", Facets: "size:" })).toBe(
      "issue_tracker.jira.field_labels.Facets",
    );
  });
});

describe("Jira adapter: fields read as labels", () => {
  it("adds each value behind its field's prefix, reading the site's fields once", async () => {
    const { t, calls } = jira(
      routes({
        "GET field": SITE_FIELDS,
        "GET issue/ENG-1": TAGGED,
        "POST search/jql": page(),
      }),
      overlay(),
    );
    const read = await t.getIssue("ENG-1");
    expect(read?.labels).toEqual([
      "a",
      "size:M",
      "facet:backend",
      "facet:ui",
      "anchor:WP-3",
      "points:3",
    ]);
    const asked = String(
      calls.find((c) => c.route === "GET issue/ENG-1")?.query.fields,
    ).split(",");
    expect(asked).toContain("customfield_10050");
    expect(asked).toContain("customfield_10080");
    expect(calls.find((c) => c.path === "search/jql")?.body.fields).toContain(
      "customfield_10060",
    );
    await t.getIssue("ENG-1");
    expect(calls.filter((c) => c.route === "GET field")).toHaveLength(1);
  });

  it("asks nothing of the site when no field is configured", async () => {
    const { t, calls } = jira(
      routes({ "GET issue/ENG-1": TAGGED, "POST search/jql": page() }),
    );
    expect((await t.getIssue("ENG-1"))?.labels).toEqual(["a"]);
    expect(calls.map((c) => c.route)).not.toContain("GET field");
  });

  it("refuses a field that names no field, or several, of the site", async () => {
    for (const [fieldLabels, at] of [
      [{ Sise: "size:" }, "issue_tracker.jira.field_labels.Sise"],
      [{ Team: "team:" }, "issue_tracker.jira.field_labels.Team"],
    ] as const) {
      const { t } = jira(
        routes({ "GET field": SITE_FIELDS, "GET issue/ENG-1": TAGGED }),
        overlay(fieldLabels),
      );
      const err = await rejection(t.getIssue("ENG-1"));
      expect(err).toBeInstanceOf(TrackerConfigError);
      expect((err as TrackerConfigError).field).toBe(at);
    }
  });

  it("refuses a field whose values do not read as labels", async () => {
    const { t } = jira(
      routes({ "GET field": SITE_FIELDS, "GET issue/ENG-1": TAGGED }),
      overlay({ Driver: "driver:" }),
    );
    const err = await rejection(t.getIssue("ENG-1"));
    expect(err).toBeInstanceOf(TrackerConfigError);
    expect(String(err)).toContain('of type "user"');
  });

  it("selects a pool by a field's values, in JQL on that field", async () => {
    const { t, calls } = jira(
      routes({
        "GET field": SITE_FIELDS,
        "POST search/jql": (c: Call) =>
          /parent in/.test(jqlOf(c))
            ? { issues: [], isLast: true }
            : page(TAGGED),
      }),
      overlay(),
    );
    const pool = await t.openIssues({
      withSomeOf: [["size:M", "size:S"], ["facet:backend", "a"], ["points:3"]],
      withNoneOf: ["facet:ui", "x"],
    });
    expect(pool.map((p) => p.labels)).toEqual([
      ["a", "size:M", "facet:backend", "facet:ui", "anchor:WP-3", "points:3"],
    ]);
    expect(jqlOf(calls.find((c) => c.path === "search/jql") as Call)).toBe(
      'project = ENG AND statusCategory != Done AND cf[10050] in ("M", "S") AND (labels in ("a") OR cf[10060] in ("backend")) AND cf[10080] in (3) AND (labels not in ("x") OR labels is EMPTY) AND (cf[10060] not in ("ui") OR cf[10060] is EMPTY) ORDER BY created ASC',
    );
  });

  it("selects a labelled population by a field's value", async () => {
    const { t, calls } = jira(
      routes({ "GET field": SITE_FIELDS, "POST search/jql": page(TAGGED) }),
      overlay(),
    );
    await t.labelledIssues("size:M");
    expect(jqlOf(calls.find((c) => c.path === "search/jql") as Call)).toBe(
      'project = ENG AND cf[10050] = "M" ORDER BY created ASC',
    );
  });

  it("refuses to select by a text field, which JQL matches only by words", async () => {
    const { t, calls } = jira(routes({ "GET field": SITE_FIELDS }), overlay());
    const err = await rejection(
      t.openIssues({ withSomeOf: [["anchor:WP-3"]] }),
    );
    expect(err).toBeInstanceOf(TrackerRequestError);
    expect((err as TrackerRequestError).code).toBe("invalid");
    expect(calls.map((c) => c.path)).not.toContain("search/jql");
  });

  it("refuses to write a field's value as a label", async () => {
    const { t, calls } = jira(routes({ "GET field": SITE_FIELDS }), overlay());
    const filed = await rejection(
      t.createIssue({ title: "New", description: "", labels: ["a", "size:M"] }),
    );
    expect(filed).toBeInstanceOf(TrackerRequestError);
    expect(String(filed)).toContain("field_labels.Size");
    const patched = await rejection(
      t.updateIssue("ENG-1", { removeLabels: ["facet:ui"] }),
    );
    expect(patched).toBeInstanceOf(TrackerRequestError);
    expect(writes(calls)).toEqual([]);
  });
});
