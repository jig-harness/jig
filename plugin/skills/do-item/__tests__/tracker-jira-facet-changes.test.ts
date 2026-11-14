import { describe, expect, it } from "bun:test";
import { SITE, SIZE_OPTIONS, STORES } from "./jira-facet-fixtures.ts";
import { issue, jira, routes, writes } from "./jira-fixtures.ts";

/** The issue types the edit screen offers an issue of one workflow. */
const EDIT_TYPES = {
  allowedValues: [
    { id: "t1", name: "Bug" },
    { id: "t2", name: "Story" },
    { id: "t3", name: "Task" },
  ],
};

describe("Jira: changing a type and a size kept in Jira's own fields", () => {
  const change = async (
    current: Record<string, unknown>,
    patch: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": current,
        "GET issue/ENG-1/editmeta": {
          fields: {
            customfield_10050: { allowedValues: SIZE_OPTIONS },
            issuetype: EDIT_TYPES,
          },
        },
        "PUT issue/ENG-1": null,
        ...extra,
      }),
      STORES,
    );
    await t.updateIssue("ENG-1", patch);
    return calls
      .filter((c) => c.route === "PUT issue/ENG-1")
      .map((c) => c.body);
  };

  it("moves a type to its issue type and takes its labels off, in one write", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Task", labels: ["docs"] }), {
        type: "bug",
      }),
    ).toEqual([
      {
        fields: { issuetype: { id: "t1" } },
        update: { labels: [{ remove: "docs" }] },
      },
    ]);
  });

  it("gives a type with no issue type of its own the fallback issue type and its label", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Bug" }), { type: "chore" }),
    ).toEqual([
      {
        fields: { issuetype: { id: "t3" } },
        update: { labels: [{ add: "chore" }] },
      },
    ]);
    expect(
      await change(issue({ key: "ENG-1", type: "Task", labels: ["docs"] }), {
        type: "chore",
      }),
    ).toEqual([{ update: { labels: [{ add: "chore" }, { remove: "docs" }] } }]);
  });

  it("changes the issue type the edit screen offers", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Task" }), { type: "feature" }),
    ).toEqual([{ fields: { issuetype: { id: "t2" } } }]);
  });

  /** A type change on an issue whose edit screen offers `issuetype` as given, with every call made. */
  const across = async (
    issuetype: Record<string, unknown> | undefined,
    patch: Record<string, unknown>,
    current = issue({ key: "ENG-1", type: "Task" }),
  ) => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": current,
        "GET issue/ENG-1/editmeta": {
          fields: {
            customfield_10050: { allowedValues: SIZE_OPTIONS },
            ...(issuetype === undefined ? {} : { issuetype }),
          },
        },
        "PUT issue/ENG-1": null,
      }),
      STORES,
    );
    const err = await t.updateIssue("ENG-1", patch).catch((e: unknown) => e);
    return { err, calls };
  };

  it("leaves the write to Jira when the edit screen has no issue type field, which screen configuration also explains", async () => {
    const { err, calls } = await across(undefined, { type: "feature" });
    expect(err).toBeUndefined();
    expect(
      calls.filter((c) => c.route === "PUT issue/ENG-1").map((c) => c.body),
    ).toEqual([{ fields: { issuetype: { id: "t2" } } }]);
  });

  it("names every cause, not only the credential, when the edit screen lists no field at all", async () => {
    const { t, calls } = jira(
      routes({
        ...SITE,
        "GET issue/ENG-1": issue({ key: "ENG-1", type: "Task" }),
        "GET issue/ENG-1/editmeta": { fields: {} },
      }),
      STORES,
    );
    const err = await t
      .updateIssue("ENG-1", { type: "feature" })
      .catch((e: unknown) => e);
    expect((err as Error).message).toBe(
      "type feature is kept in Jira's issue types as 'Story', but the edit screen of ENG-1 lists no field at all; Jira answers that when the credential may not edit the issue (Edit Issues permission), when the issue's current workflow step is not editable, or when no field is on its edit screen",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("changes the type when the edit screen has the issue type field without listing its choices", async () => {
    const { err, calls } = await across({}, { type: "feature" });
    expect(err).toBeUndefined();
    expect(
      calls.filter((c) => c.route === "PUT issue/ENG-1").map((c) => c.body),
    ).toEqual([{ fields: { issuetype: { id: "t2" } } }]);
  });

  it("refuses, before any write, a type change to an issue type the edit screen does not offer", async () => {
    const { err, calls } = await across(
      {
        allowedValues: [
          { id: "t1", name: "Bug" },
          { id: "t3", name: "Task" },
        ],
      },
      { type: "feature" },
    );
    expect((err as Error).message).toContain(
      "the edit screen of ENG-1 lets its issue type change from Task to Bug only: Jira changes",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("refuses moving to the fallback issue type the edit screen does not offer", async () => {
    const { err, calls } = await across(
      {
        allowedValues: [
          { id: "t1", name: "Bug" },
          { id: "t2", name: "Story" },
        ],
      },
      { type: "chore" },
      issue({ key: "ENG-1", type: "Story" }),
    );
    expect((err as Error).message).toContain(
      "type chore is kept in the label 'chore' on the issue type Task, but the edit screen of ENG-1 lets its issue type change from Story to Bug only",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("asks the edit screen once when a write changes both the type and the size", async () => {
    const { err, calls } = await across(EDIT_TYPES, {
      type: "feature",
      size: "large",
    });
    expect(err).toBeUndefined();
    expect(
      calls.filter((c) => c.route === "GET issue/ENG-1/editmeta"),
    ).toHaveLength(1);
    expect(
      calls.filter((c) => c.route === "PUT issue/ENG-1").map((c) => c.body),
    ).toEqual([
      {
        fields: {
          issuetype: { id: "t2" },
          customfield_10050: { value: "L" },
        },
      },
    ]);
  });

  it("writes nothing for a type already in force", async () => {
    expect(
      await change(issue({ key: "ENG-1", type: "Story" }), { type: "feature" }),
    ).toEqual([]);
  });

  it("refuses to remove a type the issue type holds", async () => {
    await expect(
      change(issue({ key: "ENG-1", type: "Bug" }), { type: null }),
    ).rejects.toThrow(
      "a Jira issue always has an issue type, and ENG-1's is Bug, the type bug",
    );
  });

  it("refuses to remove the label of the type the write sets", async () => {
    await expect(
      change(
        issue({
          key: "ENG-1",
          type: "Sub-task",
          subtask: true,
          labels: ["bug"],
        }),
        {
          type: "bug",
          removeLabels: ["bug"],
        },
      ),
    ).rejects.toThrow("the label 'bug' to remove is the type 'bug'");
  });

  it("lets a write remove a label the type it sets no longer needs", async () => {
    const writes = await change(
      issue({ key: "ENG-1", type: "Task", labels: ["bug"] }),
      { type: "bug", removeLabels: ["bug"] },
    );
    expect(writes).toHaveLength(1);
    expect(JSON.stringify(writes[0])).toContain('"remove":"bug"');
  });

  it("sets and clears the size field, its option checked against the edit screen", async () => {
    const current = issue({
      key: "ENG-1",
      fields: { customfield_10050: { value: "S" } },
    });
    expect(await change(current, { size: "large" })).toEqual([
      { fields: { customfield_10050: { value: "L" } } },
    ]);
    expect(await change(current, { size: null })).toEqual([
      { fields: { customfield_10050: null } },
    ]);
    await expect(
      change(
        current,
        { size: "large" },
        {
          "GET issue/ENG-1/editmeta": {
            fields: {
              customfield_10050: {
                allowedValues: [{ value: "S" }, { value: "M" }],
              },
            },
          },
        },
      ),
    ).rejects.toThrow("which has S, M");
  });
});
