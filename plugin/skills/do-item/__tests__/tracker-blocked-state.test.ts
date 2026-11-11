/**
 * The optional `blocked` canonical state: unset by default, a name of its
 * own, read back by each adapter's model, never a claim's start, and on Jira
 * the fields it writes.
 */
import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { gitHubModel } from "../scripts/lib/tracker/github/model.ts";
import { jiraModel } from "../scripts/lib/tracker/jira/model.ts";
import {
  blockedFieldValue,
  resolveBlockedFields,
} from "../scripts/lib/tracker/jira/blocked-fields.ts";
import { parseJiraSettings } from "../scripts/lib/tracker/jira/settings.ts";
import { blockedClaimRefusal } from "../scripts/lib/blocked-claim.ts";
import type { PoolIssue } from "../scripts/lib/tracker/port.ts";
import { jira, routes, SITE } from "./jira-fixtures.ts";

describe("the blocked state's name", () => {
  it("is unset by default, and named on its own", () => {
    expect(parseTrackerConfig({}).states.blocked).toBeNull();
    expect(
      parseTrackerConfig({ issue_tracker: { states: { blocked: "Blocked" } } })
        .states.blocked,
    ).toBe("Blocked");
  });

  it("shares a name with no other state", () => {
    for (const other of ["In Progress", "In Review", "To Do", "Done"])
      expect(() =>
        parseTrackerConfig({
          issue_tracker: {
            states: { blocked: other, todo: "To Do", in_review: "In Review" },
          },
        }),
      ).toThrow(`both name '${other}'`);
  });
});

describe("reading an item in blocked", () => {
  it("on GitHub, by its label and on a board", () => {
    const stateOf = (
      states: Record<string, string>,
      github: Record<string, unknown>,
      issue: { labels?: string[]; status?: string | null },
    ) => {
      const config = parseTrackerConfig({
        issue_tracker: { states, github: { repository: "o/r", ...github } },
      });
      return gitHubModel(config.states, config.github).stateOf({
        open: true,
        stateReason: null,
        labels: issue.labels ?? [],
        status: issue.status ?? null,
      });
    };
    expect(
      stateOf({ blocked: "state:blocked" }, {}, { labels: ["state:blocked"] }),
    ).toBe("blocked");
    const board = {
      states_from: "project",
      project: "https://github.com/orgs/o/projects/1",
    };
    expect(stateOf({ blocked: "Blocked" }, board, { status: "Blocked" })).toBe(
      "blocked",
    );
    // Unset, the label is an ordinary label.
    expect(stateOf({}, {}, { labels: ["Blocked"] })).toBe("todo");
  });

  it("on Jira, whatever category the status is in", () => {
    const config = parseTrackerConfig({
      issue_tracker: { states: { blocked: "Blocked" } },
    });
    const model = jiraModel(config.states, config.jira);
    for (const category of ["new", "indeterminate", "done"])
      expect(
        model.read({
          status: { id: "9", name: "Blocked", category },
          resolution: null,
        }).canonical,
      ).toBe("blocked");
  });
});

describe("a claim", () => {
  const pool = (name: string) =>
    ({
      identifier: "ENG-1",
      state: { id: "s", name, type: "started" },
    }) as PoolIssue | null;

  it("refuses an item in blocked before anything is written", async () => {
    const refusal = await blockedClaimRefusal(
      {
        stateName: ((s: string) => (s === "blocked" ? "Blocked" : s)) as never,
        poolIssue: async () => pool("In Progress"),
      },
      "ENG-1",
    );
    expect(refusal).toBeNull();
    const refused = await blockedClaimRefusal(
      {
        stateName: ((s: string) => (s === "blocked" ? "Blocked" : s)) as never,
        poolIssue: async () => pool("blocked "),
      },
      "ENG-1",
    );
    expect(refused?.why).toBe("blocked");
    expect(refused?.outcome).toBe("refused");
  });

  it("reads nothing when the state is unset", async () => {
    let read = false;
    expect(
      await blockedClaimRefusal(
        {
          stateName: (() => null) as never,
          poolIssue: async () => {
            read = true;
            return pool("Blocked");
          },
        },
        "ENG-1",
      ),
    ).toBeNull();
    expect(read).toBe(false);
  });
});

describe("issue_tracker.jira.blocked_fields", () => {
  it("reads reason and since, each optional", () => {
    expect(parseJiraSettings({}).blockedFields).toEqual({
      reason: null,
      since: null,
    });
    expect(
      parseJiraSettings({
        blocked_fields: {
          reason: "Blocked Reason",
          since: "customfield_10050",
        },
      }).blockedFields,
    ).toEqual({ reason: "Blocked Reason", since: "customfield_10050" });
  });

  it("refuses another key, a blank name, and one field for both", () => {
    expect(() =>
      parseJiraSettings({ blocked_fields: { owner: "Blocked By" } }),
    ).toThrow(
      "issue_tracker.jira.blocked_fields.owner is not one of reason, since",
    );
    expect(() =>
      parseJiraSettings({ blocked_fields: { reason: " " } }),
    ).toThrow("issue_tracker.jira.blocked_fields.reason");
    expect(() =>
      parseJiraSettings({
        blocked_fields: { reason: "Blocked", since: "blocked" },
      }),
    ).toThrow("for both reason and since");
  });

  const SITE_FIELDS = [
    {
      id: "customfield_1",
      name: "Blocked Reason",
      schema: { type: "string", custom: "x:textfield" },
    },
    {
      id: "customfield_2",
      name: "Blocked Since",
      schema: { type: "datetime" },
    },
    {
      id: "customfield_3",
      name: "Notes",
      schema: { type: "string", custom: "x:textarea" },
    },
    { id: "customfield_4", name: "Notes", schema: { type: "string" } },
    { id: "customfield_5", name: "Due", schema: { type: "date" } },
    { id: "customfield_6", name: "Points", schema: { type: "number" } },
  ];
  const VALUE = {
    reason: "human-decision: Run the backfill first?",
    since: "2026-11-11T09:30:00.000Z",
  };

  it("writes each value in the form its field takes, and clears with null", () => {
    const [reason, since] = resolveBlockedFields(
      { reason: "Blocked Reason", since: "customfield_2" },
      SITE_FIELDS,
    );
    expect(blockedFieldValue(reason as never, VALUE)).toBe(VALUE.reason);
    expect(blockedFieldValue(since as never, VALUE)).toBe(
      "2026-11-11T09:30:00.000+0000",
    );
    expect(blockedFieldValue(since as never, null)).toBeNull();
    const [date] = resolveBlockedFields(
      { reason: null, since: "Due" },
      SITE_FIELDS,
    );
    expect(blockedFieldValue(date as never, VALUE)).toBe("2026-11-11");
    const [area] = resolveBlockedFields(
      { reason: "customfield_3", since: null },
      SITE_FIELDS,
    );
    expect(blockedFieldValue(area as never, VALUE)).toMatchObject({
      type: "doc",
    });
  });

  it("refuses two roles that resolve to the same field", () => {
    expect(() =>
      resolveBlockedFields(
        { reason: "Blocked Reason", since: "customfield_1" },
        SITE_FIELDS,
      ),
    ).toThrow("need different fields");
  });

  it("refuses a name matching several fields, none, or a field of another type", () => {
    expect(() =>
      resolveBlockedFields({ reason: "Notes", since: null }, SITE_FIELDS),
    ).toThrow("matches 2 fields");
    expect(() =>
      resolveBlockedFields({ reason: "Nope", since: null }, SITE_FIELDS),
    ).toThrow("matches 0 fields");
    const [points] = resolveBlockedFields(
      { reason: "Points", since: null },
      SITE_FIELDS,
    );
    expect(() => blockedFieldValue(points as never, VALUE)).toThrow(
      "needs a text field",
    );
  });

  it("the adapter writes the configured fields in one request, and nothing without them", async () => {
    const { t, calls } = jira(
      routes({ "GET field": SITE_FIELDS, "PUT issue/ENG-1": {} }),
      {
        issue_tracker: {
          jira: {
            site: SITE,
            blocked_fields: {
              reason: "Blocked Reason",
              since: "Blocked Since",
            },
          },
        },
      },
    );
    expect(await t.writeBlockedFields?.("ENG-1", VALUE)).toBe(true);
    const put = calls.find((c) => c.route === "PUT issue/ENG-1");
    expect(put?.body).toEqual({
      fields: {
        customfield_1: VALUE.reason,
        customfield_2: "2026-11-11T09:30:00.000+0000",
      },
    });
    const bare = jira(routes({}));
    expect(await bare.t.writeBlockedFields?.("ENG-1", VALUE)).toBe(false);
    expect(bare.calls).toEqual([]);
  });
});
