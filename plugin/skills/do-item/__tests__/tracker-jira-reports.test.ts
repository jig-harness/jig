import { describe, expect, it } from "bun:test";
import { readPickups } from "../../../dispatch/lib/sources/tracker.ts";
import { TrackerRequestError } from "../scripts/lib/tracker/port.ts";
import { JiraApiError } from "../scripts/lib/tracker/jira/transport.ts";
import {
  APP,
  assignable,
  type Call,
  comment,
  comments,
  FACTORY,
  issue,
  jira,
  jqlOf,
  MEMBER,
  page,
  routes,
} from "./jira-fixtures.ts";

const DAY = 86_400_000;
const at = (iso: string) => Date.parse(iso);

/** A search answer chosen by what the JQL asks for. */
const byJql =
  (...cases: Array<[RegExp, Record<string, unknown>]>) =>
  (c: Call) => {
    const hit = cases.find(([re]) => re.test(jqlOf(c)));
    return hit === undefined ? new Error(`unexpected JQL ${jqlOf(c)}`) : hit[1];
  };

const MYSELF = { accountId: FACTORY.accountId, timeZone: "Europe/Berlin" };

describe("Jira adapter: issues by key", () => {
  it("reads the keys in batches with their parent chains", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": byJql(
          [
            /^project = ENG AND key in \(ENG-1, ENG-2\)/,
            page(issue({ key: "ENG-1", parent: "ENG-10", labels: ["x"] })),
          ],
          [
            /^key in \(ENG-10\)/,
            page(
              issue({ key: "ENG-10", parent: "ENG-20", labels: ["feature"] }),
            ),
          ],
          [
            /^key in \(ENG-20\)/,
            page(issue({ key: "ENG-20", labels: ["epic"] })),
          ],
        ),
      }),
    );
    const found = await t.issuesByKeys(["ENG-1", "ENG-2", "#3", "OPS-1"]);
    expect([...found.keys()]).toEqual(["ENG-1"]);
    expect(found.get("ENG-1")?.ancestors).toEqual([
      { id: "ENG-10", labels: ["feature"] },
      { id: "ENG-20", labels: ["epic"] },
    ]);
    expect(calls).toHaveLength(3);
  });

  it("drops a key JQL calls unknown and asks again", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": (c: Call) =>
          jqlOf(c).includes("ENG-9")
            ? new JiraApiError("HTTP 400", {
                status: 400,
                errorMessages: [
                  "An issue with key 'ENG-9' does not exist for field 'key'.",
                ],
              })
            : page(issue({ key: "ENG-1" })),
      }),
    );
    expect([...(await t.issuesByKeys(["ENG-1", "ENG-9"])).keys()]).toEqual([
      "ENG-1",
    ]);
    expect(calls).toHaveLength(2);
  });

  it("fails on a sixth ancestor rather than attribute short", async () => {
    const chain = (n: number) =>
      issue({ key: `ENG-${n}`, parent: n < 7 ? `ENG-${n + 1}` : null });
    const { t } = jira(
      routes({
        "POST search/jql": (c: Call) => {
          const keys = [...jqlOf(c).matchAll(/ENG-(\d+)/g)].map((m) =>
            Number(m[1]),
          );
          return page(...keys.map(chain));
        },
      }),
    );
    await expect(t.issuesByKeys(["ENG-1"])).rejects.toThrow(
      "more than 5 ancestors",
    );
  });
});

describe("Jira adapter: windows", () => {
  const window = {
    sinceMs: at("2026-03-01T00:00:00Z"),
    untilMs: at("2026-03-08T00:00:00Z"),
  };

  it("widens created dates by a minute in the profile's time zone and filters exactly", async () => {
    const { t, calls } = jira(
      routes({
        "GET myself": MYSELF,
        "POST search/jql": page(
          issue({ key: "ENG-1", created: "2026-02-28T23:59:30.000+0000" }),
          issue({ key: "ENG-2", created: "2026-03-01T00:00:00.000+0000" }),
          issue({ key: "ENG-3", created: "2026-03-08T00:00:10.000+0000" }),
        ),
      }),
    );
    const facts = await t.issuesInWindow({ label: "bug", createdIn: window });
    expect(facts.map((f) => f.id)).toEqual(["ENG-2"]);
    expect(jqlOf(calls[1] as Call)).toBe(
      'project = ENG AND labels = "bug" AND created >= "2026-03-01 00:59" AND created < "2026-03-08 01:01" ORDER BY created ASC',
    );
  });

  it("reads completion from the resolution date, else the category change", async () => {
    const { t, calls } = jira(
      routes({
        "GET myself": MYSELF,
        "POST search/jql": page(
          issue({
            key: "ENG-1",
            status: "Done",
            category: "done",
            resolution: "Done",
            resolutiondate: "2026-03-02T10:00:00.000+0000",
          }),
          issue({
            key: "ENG-2",
            status: "Done",
            category: "done",
            statuscategorychangedate: "2026-03-03T10:00:00.000+0000",
          }),
          issue({
            key: "ENG-3",
            status: "Done",
            category: "done",
            resolution: "Won't Do",
            resolutiondate: "2026-03-03T10:00:00.000+0000",
          }),
          issue({
            key: "ENG-4",
            status: "Done",
            category: "done",
            resolutiondate: "2026-02-03T10:00:00.000+0000",
          }),
        ),
      }),
      { issue_tracker: { states: { canceled: "Done", duplicate: "Done" } } },
    );
    const facts = await t.issuesInWindow({ completedIn: window });
    expect(facts.map((f) => [f.id, f.completedAt])).toEqual([
      ["ENG-1", "2026-03-02T10:00:00.000Z"],
      ["ENG-2", "2026-03-03T10:00:00.000Z"],
    ]);
    expect(jqlOf(calls[1] as Call)).toContain(
      "statusCategory = Done AND (resolutiondate >= ",
    );
  });

  it("finds comments containing a text by reading them, with their trust", async () => {
    const { t, calls } = jira(
      routes({
        "GET myself": MYSELF,
        "POST search/jql": page(issue({ key: "ENG-1" })),
        "GET issue/ENG-1/comment": comments(
          comment(
            "1",
            "<!-- jig:finding a -->",
            MEMBER,
            "2026-03-02T00:00:00.000+0000",
          ),
          comment(
            "2",
            "<!-- jig:finding b -->",
            APP,
            "2026-03-03T00:00:00.000+0000",
          ),
          comment(
            "3",
            "<!-- jig:finding old -->",
            MEMBER,
            "2026-02-01T00:00:00.000+0000",
          ),
          comment("4", "unrelated", MEMBER, "2026-03-04T00:00:00.000+0000"),
        ),
        "GET user/assignable/search": assignable(
          MEMBER.accountId,
          APP.accountId,
        ),
      }),
    );
    const found = await t.commentsContaining({
      text: "jig:finding",
      issueLabel: "debt",
      createdIn: window,
    });
    expect(found.map((f) => [f.issue, f.body, f.trusted])).toEqual([
      ["ENG-1", "<!-- jig:finding a -->", true],
      ["ENG-1", "<!-- jig:finding b -->", false],
    ]);
    expect(jqlOf(calls[1] as Call)).toContain('updated >= "2026-03-01 00:59"');
  });
});

describe("Jira adapter: comments with trust", () => {
  it("trusts a licensed non-guest project member only, asking once per account", async () => {
    const guest = {
      ...MEMBER,
      accountId: "5b10ac8d82e05b22cc7d4ef7",
      guest: true,
    };
    const outsider = { ...MEMBER, accountId: "5b10ac8d82e05b22cc7d4ef8" };
    const { t, calls } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1", id: "10001" }),
        "GET issue/ENG-1/comment": comments(
          comment("1", "a", MEMBER),
          comment("2", "b", MEMBER),
          comment("3", "c", guest),
          comment("4", "d", outsider),
          comment("5", "e", null),
        ),
        "GET user/assignable/search": assignable(
          MEMBER.accountId,
          guest.accountId,
        ),
      }),
    );
    const { uuid, comments: read } = await t.issueComments("ENG-1");
    expect(uuid).toBe("10001");
    expect(read.map((c) => c.trusted)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(
      calls.filter((c) => c.route === "GET user/assignable/search"),
    ).toHaveLength(2);
  });

  it("fails rather than trust when membership cannot be read", async () => {
    const { t } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1" }),
        "GET issue/ENG-1/comment": comments(comment("1", "a", MEMBER)),
        "GET user/assignable/search": new JiraApiError("HTTP 503", {
          status: 503,
          unavailable: true,
        }),
      }),
    );
    await expect(t.issueComments("ENG-1")).rejects.toThrow("503");
  });
});

describe("Jira adapter: populations", () => {
  it("reads a ledger as the union of a label and a fix version, refusing an unknown label", async () => {
    const answer = (labels: string[]) =>
      routes({
        "GET label": {
          values: labels,
          startAt: 0,
          maxResults: 100,
          isLast: true,
        },
        "GET project/ENG/versions": [{ id: "70", name: "Debt" }],
        "POST search/jql": page(
          issue({
            key: "ENG-1",
            labels: ["debt"],
            priority: "Highest",
            parent: "ENG-9",
            fixVersions: ["Debt"],
          }),
          issue({
            key: "ENG-2",
            status: "Won't Do",
            category: "done",
            resolution: "Won't Do",
            resolutiondate: "2026-01-05T00:00:00.000+0000",
          }),
        ),
      });
    const { t, calls } = jira(answer(["debt", "debt-old"]), {
      issue_tracker: { states: { canceled: "Won't Do" } },
    });
    const seen: number[] = [];
    const ledger = await t.ledger({ label: "debt", project: "Debt" }, (n) =>
      seen.push(n),
    );
    expect(calls[0]?.query.query).toBe("debt");
    expect(jqlOf(calls.at(-1) as Call)).toBe(
      'project = ENG AND (labels = "debt" OR fixVersion = "Debt") ORDER BY created ASC',
    );
    expect(
      ledger.map((l) => [
        l.identifier,
        l.priority,
        l.parent,
        l.project,
        l.stateType,
        l.canceledAt,
      ]),
    ).toEqual([
      ["ENG-1", 1, "ENG-9", "Debt", "unstarted", null],
      ["ENG-2", 3, null, null, "canceled", "2026-01-05T00:00:00.000Z"],
    ]);
    expect(seen).toEqual([1, 2]);
    const err = await jira(answer(["Debt"]))
      .t.ledger({ label: "debt" })
      .catch((e: unknown) => e);
    expect((err as TrackerRequestError).code).toBe("unresolved");
  });

  it("reads labelled issues, with descriptions when asked", async () => {
    const { t } = jira(
      routes({
        "POST search/jql": page(issue({ key: "ENG-1", description: "Plan" })),
      }),
    );
    expect(await t.labelledIssues("epic", undefined, true)).toEqual([
      {
        identifier: "ENG-1",
        stateType: "unstarted",
        completedAt: null,
        description: "Plan",
      },
    ]);
  });

  it("reads started epics with their children", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": byJql(
          [
            /labels = "epic"/,
            page(
              issue({
                key: "ENG-1",
                status: "In Progress",
                category: "indeterminate",
                statuscategorychangedate: "2026-02-01T00:00:00.000+0000",
                assignee: MEMBER,
                fixVersions: ["Q1"],
                labels: ["epic"],
              }),
            ),
          ],
          [
            /parent = ENG-1/,
            page(issue({ key: "ENG-2", status: "Done", category: "done" })),
          ],
        ),
      }),
    );
    expect(await t.startedIssueActivity("epic")).toEqual([
      {
        epic: "ENG-1",
        startedAt: "2026-02-01T00:00:00.000Z",
        project: "Q1",
        assignee: "Dana Lee",
        labels: ["epic"],
        children: [
          {
            issue: "ENG-2",
            updatedAt: "2026-01-02T09:00:00.000Z",
            stateType: "completed",
          },
        ],
      },
    ]);
    expect(jqlOf(calls[0] as Call)).toContain('statusCategory = "In Progress"');
  });
});

describe("Jira adapter: candidate pools", () => {
  it("reads a pool with one JQL and its open children with one more", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": byJql(
          [
            /parent in/,
            {
              issues: [{ key: "ENG-5", fields: { parent: { key: "ENG-1" } } }],
              isLast: true,
            },
          ],
          [
            /labels in/,
            page(
              issue({
                key: "ENG-1",
                labels: ["a"],
                priority: "High",
                assignee: MEMBER,
                status: "Todo",
                statusId: "10000",
              }),
              issue({ key: "ENG-2", labels: ["b"] }),
            ),
          ],
        ),
      }),
      { issue_tracker: { states: { todo: "Todo" } } },
    );
    const pool = await t.openIssues({
      withSomeOf: [["a", "b"], ["c"]],
      withNoneOf: ["x"],
    });
    expect(jqlOf(calls[0] as Call)).toBe(
      'project = ENG AND statusCategory != Done AND labels in ("a", "b") AND labels in ("c") AND (labels not in ("x") OR labels is EMPTY) ORDER BY created ASC',
    );
    expect(jqlOf(calls[1] as Call)).toBe(
      "project = ENG AND parent in (ENG-1, ENG-2) AND statusCategory != Done ORDER BY created ASC",
    );
    expect(calls[1]?.body.fields).toEqual(["parent"]);
    expect(pool[0]).toEqual({
      identifier: "ENG-1",
      title: "Issue ENG-1",
      url: "https://example.atlassian.net/browse/ENG-1",
      priority: 2,
      createdAt: "2026-01-01T09:00:00.000Z",
      state: { id: "10000", name: "Todo", type: "unstarted" },
      assignee: { id: MEMBER.accountId, name: "Dana Lee" },
      labels: ["a"],
      hasOpenChildren: true,
      truncated: [],
    });
    expect(pool[1]?.hasOpenChildren).toBe(false);
  });

  it("refuses an empty label list", async () => {
    const { t } = jira(routes({}));
    await expect(t.openIssues({ withSomeOf: [[]] })).rejects.toBeInstanceOf(
      TrackerRequestError,
    );
  });

  it("reads open children and one issue in pool form", async () => {
    const { t, calls } = jira(
      routes({
        "POST search/jql": byJql(
          [/parent in/, page()],
          [
            /parent = ENG-1 AND statusCategory != Done/,
            page(issue({ key: "ENG-2" })),
          ],
        ),
        "GET issue/ENG-3": issue({
          key: "ENG-3",
          status: "Done",
          category: "done",
        }),
        "GET issue/ENG-4": new JiraApiError("404", {
          status: 404,
          notFound: true,
        }),
      }),
    );
    expect((await t.openChildren("ENG-1")).map((p) => p.identifier)).toEqual([
      "ENG-2",
    ]);
    expect(jqlOf(calls[0] as Call)).toContain(
      "parent = ENG-1 AND statusCategory != Done",
    );
    expect((await t.poolIssue("ENG-3"))?.state.type).toBe("completed");
    expect(await t.poolIssue("ENG-4")).toBeNull();
  });
});

describe("Jira adapter: assignments", () => {
  const assigned = (
    author: Record<string, unknown> | null,
    assignee = FACTORY,
  ) =>
    routes({
      "GET user/search": [
        {
          accountId: FACTORY.accountId,
          displayName: "Jig Factory",
          emailAddress: "factory@example.com",
        },
        {
          accountId: MEMBER.accountId,
          displayName: "Dana Lee",
          emailAddress: "dana@example.com",
        },
      ],
      "GET user": (c: Call) =>
        c.query.accountId === FACTORY.accountId
          ? FACTORY
          : new JiraApiError("404", { status: 404, notFound: true }),
      "POST search/jql": byJql(
        [/parent in/, page()],
        [
          /assignee = /,
          page(
            issue({ key: "ENG-42", status: "Todo", assignee }),
            issue({
              key: "ENG-43",
              status: "Doing",
              category: "indeterminate",
              assignee,
            }),
          ),
        ],
      ),
      "GET issue/ENG-42": issue({ key: "ENG-42", status: "Todo", assignee }),
      "GET issue/ENG-42/changelog": {
        values: [
          {
            id: "1",
            author: MEMBER,
            created: "2026-01-01T00:00:00.000+0000",
            items: [
              {
                field: "assignee",
                fieldId: "assignee",
                from: null,
                to: FACTORY.accountId,
              },
            ],
          },
          {
            id: "2",
            author: author ?? undefined,
            created: "2026-01-02T00:00:00.000+0000",
            items: [
              {
                field: "assignee",
                fieldId: "assignee",
                from: null,
                to: FACTORY.accountId,
              },
            ],
          },
          {
            id: "3",
            author: MEMBER,
            created: "2026-01-03T00:00:00.000+0000",
            items: [
              { field: "labels", fieldId: "labels", from: null, to: null },
            ],
          },
        ],
        startAt: 0,
        maxResults: 100,
        total: 3,
        isLast: true,
      },
      "GET user/assignable/search": assignable(MEMBER.accountId),
    });

  it("reads the factory's issues in the dispatch states by its account", async () => {
    const { t, calls } = jira(assigned(MEMBER));
    const issues = await t.assignedIssues("factory@example.com", ["todo"]);
    expect(issues.map((i) => i.identifier)).toEqual(["ENG-42"]);
    expect(jqlOf(calls.find((c) => /assignee/.test(jqlOf(c))) as Call)).toBe(
      `project = ENG AND assignee = "${FACTORY.accountId}" AND status in ("Todo") ORDER BY created ASC`,
    );
    await t.assignedIssues(FACTORY.accountId, ["todo"]);
    expect(
      calls.some(
        (c) =>
          c.route === "GET user" && c.query.accountId === FACTORY.accountId,
      ),
    ).toBe(true);
  });

  it("refuses an identity that names no user or several", async () => {
    const { t } = jira(
      routes({
        "GET user/search": [
          { accountId: "5b10ac8d82e05b22cc7d4e01", displayName: "Sam" },
          { accountId: "5b10ac8d82e05b22cc7d4e02", displayName: "sam" },
        ],
        "GET user": new JiraApiError("404", { status: 404, notFound: true }),
      }),
    );
    await expect(t.assignedIssues("Sam", ["todo"])).rejects.toThrow(
      "2 Jira users",
    );
    await expect(t.assignedIssues("Nobody", ["todo"])).rejects.toThrow(
      "no Jira user",
    );
    await expect(
      t.assignedIssues("5b10ac8d82e05b22cc7d4e09", ["todo"]),
    ).rejects.toThrow("account id");
    await expect(t.assignedIssues("Sam", [])).rejects.toBeInstanceOf(
      TrackerRequestError,
    );
  });

  it("traces the assignment to the newest change's author and its trust", async () => {
    expect(
      await jira(assigned(MEMBER)).t.assignedBy(
        "ENG-42",
        "factory@example.com",
      ),
    ).toEqual({
      id: MEMBER.accountId,
      name: "Dana Lee",
      trusted: true,
    });
    expect(await jira(assigned(APP)).t.assignedBy("ENG-42")).toEqual({
      id: APP.accountId,
      name: "Automation for Jira",
      trusted: false,
    });
    expect((await jira(assigned(null)).t.assignedBy("ENG-42")).trusted).toBe(
      false,
    );
  });

  it("throws when the issue is no longer the account's or holds no such change", async () => {
    await expect(
      jira(assigned(MEMBER, { ...MEMBER })).t.assignedBy(
        "ENG-42",
        "factory@example.com",
      ),
    ).rejects.toThrow("no longer assigned");
    const { t } = jira(
      routes({
        "GET issue/ENG-1": issue({ key: "ENG-1", assignee: FACTORY }),
        "GET issue/ENG-1/changelog": {
          values: [],
          startAt: 0,
          maxResults: 100,
          total: 0,
          isLast: true,
        },
      }),
    );
    await expect(t.assignedBy("ENG-1")).rejects.toThrow("holds no assignment");
  });

  it("gives the dispatcher a trusted pickup for a member's assignment and none for an app's", async () => {
    const section = {
      identity: "factory@example.com",
      states: ["todo"],
      followupCommand: null,
    };
    const member = await readPickups(() => jira(assigned(MEMBER)).t, section);
    expect(member.read.ok).toBe(true);
    expect(member.wanted.map((w) => [w.key, w.assignedBy])).toEqual([
      ["ENG-42", "Dana Lee"],
    ]);
    expect(member.unplaced).toEqual([]);
    const app = await readPickups(() => jira(assigned(APP)).t, section);
    expect(app.wanted).toEqual([]);
    expect(app.unplaced.map((u) => u.target)).toEqual(["ENG-42"]);
    expect(app.unplaced[0]?.reason).toContain("Automation for Jira");
  });
});

describe("Jira adapter: dates", () => {
  it("formats JQL dates in the profile's zone", async () => {
    const { jqlDate } = await import("../scripts/lib/tracker/jira/jql.ts");
    expect(jqlDate(at("2026-07-01T22:30:00Z"), "America/New_York")).toBe(
      "2026-07-01 18:30",
    );
    expect(jqlDate(at("2026-07-01T22:30:00Z") + DAY, "UTC")).toBe(
      "2026-07-02 22:30",
    );
  });
});
