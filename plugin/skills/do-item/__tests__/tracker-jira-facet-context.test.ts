import { describe, expect, it } from "bun:test";
import { jiraFacetStores } from "../scripts/lib/tracker/jira/facets.ts";
import { parseIssue } from "../scripts/lib/tracker/jira/read.ts";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import { SITE, STORES } from "./jira-facet-fixtures.ts";
import {
  issue,
  jira,
  MEMBER,
  page,
  routes,
  SITE as SITE_URL,
} from "./jira-fixtures.ts";

/**
 * Jira Cloud leaves a custom field out of an issue's `fields` when the
 * issue's type has no context for it, even when the read names the field.
 * Such an issue has no value in the field the size is kept in.
 */
describe("Jira: an issue whose type has no context for the size field", () => {
  const epic = issue({
    key: "ENG-1",
    type: "Epic",
    typeLevel: 1,
    priority: "High",
    labels: ["area:api"],
  });

  it("reads an Epic the response gives without the size field, with no size and every other fact", async () => {
    const { t, calls } = jira(
      routes({ ...SITE, "GET issue/ENG-1": epic }),
      STORES,
    );
    const read = await t.getIssue("ENG-1");
    expect(read).not.toBeNull();
    expect([
      read?.identifier,
      read?.size,
      read?.priority,
      read?.labels,
    ]).toEqual(["ENG-1", null, 2, ["area:api"]]);
    expect(read?.nativeType).toBe("Epic");
    const asked = calls.find((c) => c.route === "GET issue/ENG-1");
    expect(String(asked?.query.fields).split(",")).toContain(
      "customfield_10050",
    );
    expect((await t.poolIssue("ENG-1"))?.size).toBeNull();
  });

  it("reads a Bug and a Sub-task found by a search without the size field", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "POST search/jql": page(
          issue({ key: "ENG-2", type: "Bug", status: "Todo" }),
          issue({
            key: "ENG-3",
            type: "Sub-task",
            subtask: true,
            status: "Todo",
          }),
        ),
      }),
      STORES,
    );
    const found = await t.unassignedIssues?.(["todo"]);
    expect(found?.map((i) => [i.identifier, i.size])).toEqual([
      ["ENG-2", null],
      ["ENG-3", null],
    ]);
    const asked = calls.find((c) => c.route === "POST search/jql");
    expect(asked?.body.fields).toContain("customfield_10050");
  });

  it("projects an Epic the dispatcher read without the size field", async () => {
    const { t } = jira(
      routes({
        ...SITE,
        "GET user": MEMBER,
        "POST search/jql": (call: { body: Record<string, unknown> }) =>
          String(call.body.jql).includes("assignee") ? page(epic) : page(),
      }),
      STORES,
    );
    const source = t.dispatchSource;
    expect(source).toBeDefined();
    const [raw] = (await source?.queue(MEMBER.accountId)) ?? [];
    expect(raw).toBeDefined();
    const projected = await source?.project(raw as NonNullable<typeof raw>);
    expect([projected?.identifier, projected?.size]).toEqual(["ENG-1", null]);
  });

  // Jira gives a named field it holds no context for as absent and one it
  // does as `null` when unset, so an absent named field is read as unset
  // whichever the issue type is: the response is all a read can know.
  it("reads a Task the response gives without the size field as having no size", async () => {
    const { t } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": issue({ key: "ENG-1", type: "Task" }),
      }),
      STORES,
    );
    expect((await t.getIssue("ENG-1"))?.size).toBeNull();
  });
});

describe("Jira: an issue read without naming the size field", () => {
  const raw = issue({
    key: "ENG-1",
    type: "Task",
    fields: { customfield_10050: { value: "M" } },
  });
  const sizeField = { facet: "size" as const, id: "customfield_10050" };
  const strip = (r: Record<string, unknown>) => {
    const { customfield_10050: _, ...fields } = r.fields as Record<
      string,
      unknown
    >;
    return { ...r, fields };
  };

  it("keeps a field the read named and Jira left out as no value, and one it never named as unread", () => {
    const omitted = strip(raw);
    expect(
      parseIssue(omitted, SITE_URL, [], [sizeField], ["customfield_10050"])
        .facetValues,
    ).toEqual({ size: [] });
    expect(
      parseIssue(omitted, SITE_URL, [], [sizeField], ["*all"]).facetValues,
    ).toEqual({ size: [] });
    expect(
      parseIssue(omitted, SITE_URL, [], [sizeField], ["summary"]).facetValues,
    ).toEqual({});
    expect(parseIssue(omitted, SITE_URL, [], [sizeField]).facetValues).toEqual(
      {},
    );
    expect(
      parseIssue(raw, SITE_URL, [], [sizeField], ["summary"]).facetValues,
    ).toEqual({ size: ["M"] });
  });

  it("refuses to read the size of an issue read without its field, naming the field", async () => {
    const { client } = jira(routes({ ...SITE }), STORES);
    const unread = parseIssue(strip(raw), SITE_URL, [], [sizeField]);
    const stores = jiraFacetStores(client);
    expect(() => stores.read(unread)).toThrow(TrackerRequestError);
    expect(() => stores.read(unread)).toThrow(
      "issue ENG-1 was read without the field 'Size' that size is kept in",
    );
  });
});
