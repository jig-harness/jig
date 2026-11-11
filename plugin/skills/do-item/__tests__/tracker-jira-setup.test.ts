import { beforeEach, describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { TrackerConfigError } from "../scripts/lib/tracker/config-error.ts";
import { openTracker } from "../scripts/lib/tracker/index.ts";
import { iso } from "../scripts/lib/tracker/jira/read.ts";
import { parseJiraSettings } from "../scripts/lib/tracker/jira/settings.ts";
import {
  jiraAuthorization,
  resolveJiraCredential,
} from "../scripts/lib/tracker/jira/credential.ts";
import {
  defaultTransport,
  httpTransport,
  type JiraApiError,
  type JiraTransport,
  offsetPages,
  searchPages,
} from "../scripts/lib/tracker/jira/transport.ts";
import {
  budgetGovernor,
  isRateLimited,
  memoryBudgetStore,
} from "../../../shared/tracker-budget.ts";
import { GATEWAY, SITE, tokenRun } from "./jira-fixtures.ts";

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

describe("issue_tracker.jira", () => {
  it("fills in the defaults", () => {
    expect(parseJiraSettings({ site: `${SITE}/` })).toEqual({
      site: SITE,
      apiBase: null,
      issueType: "Task",
      subtaskType: null,
      priorities: {
        urgent: "Highest",
        high: "High",
        medium: "Medium",
        low: "Low",
      },
      resolutions: {
        done: "Done",
        canceled: "Won't Do",
        duplicate: "Duplicate",
      },
      linkTypes: {
        blocks: [{ name: "Blocks", inverted: false }],
        related: [{ name: "Relates", inverted: false }],
        duplicate: [{ name: "Duplicate", inverted: false }],
      },
      fieldLabels: {},
      poolIssueTypes: [],
    });
  });

  it("reads a relation as one link type or a list of names and { name, inverted }", () => {
    const s = parseJiraSettings({
      link_types: {
        blocks: [
          "Blocks",
          { name: " Depends ", inverted: true },
          { name: "Precedes" },
        ],
        related: "Relates",
      },
    });
    expect(s.linkTypes.blocks).toEqual([
      { name: "Blocks", inverted: false },
      { name: "Depends", inverted: true },
      { name: "Precedes", inverted: false },
    ]);
    expect(s.linkTypes.related).toEqual([{ name: "Relates", inverted: false }]);
  });

  it("refuses a malformed link type list, and a name in two lists", () => {
    const of = (link_types: unknown) =>
      fieldOf(() => parseJiraSettings({ link_types }));
    expect(of({ blocks: [] })).toBe("issue_tracker.jira.link_types.blocks");
    expect(of({ blocks: ["Blocks", 3] })).toBe(
      "issue_tracker.jira.link_types.blocks[1]",
    );
    expect(of({ blocks: [{ name: "Depends", inverted: "yes" }] })).toBe(
      "issue_tracker.jira.link_types.blocks[0].inverted",
    );
    expect(of({ blocks: [{ name: "Depends", direction: "in" }] })).toBe(
      "issue_tracker.jira.link_types.blocks[0].direction",
    );
    expect(of({ related: [{ name: "Relates", inverted: true }] })).toBe(
      "issue_tracker.jira.link_types.related[0].inverted",
    );
    expect(of({ blocks: ["Blocks", "Depends"], related: ["depends"] })).toBe(
      "issue_tracker.jira.link_types",
    );
    expect(of({ blocks: ["Blocks", "blocks"] })).toBe(
      "issue_tracker.jira.link_types",
    );
  });

  it("reads pool_issue_types as a list of names, refusing an empty or repeated one", () => {
    expect(
      parseJiraSettings({ pool_issue_types: ["Task", " Bug "] }).poolIssueTypes,
    ).toEqual(["Task", "Bug"]);
    const of = (pool_issue_types: unknown) =>
      fieldOf(() => parseJiraSettings({ pool_issue_types }));
    expect(of([])).toBe("issue_tracker.jira.pool_issue_types");
    expect(of("Task")).toBe("issue_tracker.jira.pool_issue_types");
    expect(of(["Task", ""])).toBe("issue_tracker.jira.pool_issue_types[1]");
    expect(of(["Task", "task"])).toBe("issue_tracker.jira.pool_issue_types");
  });

  it("refuses each malformed field, naming it", () => {
    expect(fieldOf(() => parseJiraSettings({ sight: SITE }))).toBe(
      "issue_tracker.jira.sight",
    );
    expect(
      fieldOf(() =>
        parseJiraSettings({ site: "http://example.atlassian.net" }),
      ),
    ).toBe("issue_tracker.jira.site");
    expect(
      fieldOf(() => parseJiraSettings({ site: "https://attacker.example" })),
    ).toBe("issue_tracker.jira.site");
    expect(
      fieldOf(() => parseJiraSettings({ site: "https://localhost" })),
    ).toBe("issue_tracker.jira.site");
    expect(fieldOf(() => parseJiraSettings({ issue_type: "" }))).toBe(
      "issue_tracker.jira.issue_type",
    );
    expect(
      fieldOf(() => parseJiraSettings({ priorities: { highest: "Highest" } })),
    ).toBe("issue_tracker.jira.priorities.highest");
    expect(
      fieldOf(() => parseJiraSettings({ resolutions: { canceled: "Done" } })),
    ).toBe("issue_tracker.jira.resolutions");
    expect(fieldOf(() => parseJiraSettings({ link_types: "Blocks" }))).toBe(
      "issue_tracker.jira.link_types",
    );
    expect(fieldOf(() => parseJiraSettings([]))).toBe("issue_tracker.jira");
  });

  it("stores mapped names trimmed, so a read and a write mean the same", () => {
    const s = parseJiraSettings({
      priorities: { urgent: " Highest " },
      link_types: { blocks: " Blocks\t" },
    });
    expect(s.priorities.urgent).toBe("Highest");
    expect(s.linkTypes.blocks).toEqual([{ name: "Blocks", inverted: false }]);
  });

  it("lets the closed states share a status under Jira only", () => {
    const states = { done: "Done", canceled: "Done", duplicate: "Done" };
    expect(
      parseTrackerConfig({
        issue_tracker: { adapter: "jira", team: "ENG", states },
      }).states.canceled,
    ).toBe("Done");
    expect(
      fieldOf(() =>
        parseTrackerConfig({
          issue_tracker: { adapter: "linear", team: "ENG", states },
        }),
      ),
    ).toBe("issue_tracker.states.canceled");
    expect(
      fieldOf(() =>
        parseTrackerConfig({
          issue_tracker: {
            adapter: "jira",
            team: "ENG",
            states: { in_progress: "Done" },
          },
        }),
      ),
    ).toBe("issue_tracker.states.done");
  });

  it("opens only with a project key and a site", () => {
    expect(() =>
      openTracker(
        parseTrackerConfig({
          issue_tracker: { adapter: "jira", jira: { site: SITE } },
        }),
        ".",
      ),
    ).toThrow("issue_tracker.team");
    expect(
      fieldOf(() =>
        openTracker(
          parseTrackerConfig({
            issue_tracker: { adapter: "jira", team: "ENG" },
          }),
          ".",
        ),
      ),
    ).toBe("issue_tracker.jira.site");
    const t = openTracker(
      parseTrackerConfig({
        issue_tracker: { adapter: "jira", team: "ENG", jira: { site: SITE } },
      }),
      ".",
    );
    expect([t.adapter, t.team, t.stateName("in_review")]).toEqual([
      "jira",
      "ENG",
      "In Review",
    ]);
  });

  it("refuses a team without an adapter, naming Jira as one that has one", () => {
    expect(() =>
      parseTrackerConfig({ issue_tracker: { team: "ENG" } }),
    ).toThrow("jira");
  });
});

/** Each way a request is signed, to the base each is used with. */
const MODES = [
  {
    name: "Basic, to the site",
    base: SITE,
    auth: () =>
      jiraAuthorization({
        kind: "basic",
        email: "factory@example.com",
        token: "t0ken",
      }),
    header: `Basic ${Buffer.from("factory@example.com:t0ken").toString("base64")}`,
  },
  {
    name: "Bearer, to the gateway",
    base: GATEWAY,
    auth: () => jiraAuthorization({ kind: "bearer", token: "be4rer" }),
    header: "Bearer be4rer",
  },
  {
    name: "a token command, to the gateway",
    base: GATEWAY,
    auth: () =>
      jiraAuthorization(
        { kind: "command", argv: ["broker", "token"] },
        { runner: async () => tokenRun("c0mmand\n") },
      ),
    header: "Bearer c0mmand",
  },
];

describe.each(MODES)("Jira transport: $name", (mode) => {
  interface Sent {
    url: string;
    init: RequestInit;
  }
  const fake = (
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ) => {
    const sent: Sent[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return new Response(status === 204 ? null : body, { status, headers });
    }) as typeof fetch;
    return { sent, impl };
  };
  let credential = mode.auth();
  beforeEach(() => {
    credential = mode.auth();
  });

  it("does not follow redirects with the credential", async () => {
    const { sent, impl } = fake(302, "", {
      location: "https://other.example/",
    });
    await expect(
      httpTransport(
        mode.base,
        credential,
        impl,
      )({ method: "GET", path: "myself" }),
    ).rejects.toThrow();
    expect(sent[0]?.init.redirect).toBe("manual");
  });

  it("fails a mutation whose success body is lost mid-read", async () => {
    const impl = (async () => {
      const body = new ReadableStream({
        start(c) {
          c.error(new Error("connection reset"));
        },
      });
      return new Response(body, { status: 201 });
    }) as unknown as typeof fetch;
    await expect(
      httpTransport(
        mode.base,
        credential,
        impl,
      )({
        method: "POST",
        path: "issue/ENG-1/comment",
        body: {},
      }),
    ).rejects.toMatchObject({ answerLost: true, status: 201 });
  });

  it("sends the credential, JSON and the query under /rest/api/3", async () => {
    const { sent, impl } = fake(200, '{"ok":true}');
    const t = httpTransport(mode.base, credential, impl);
    expect(
      await t({
        method: "POST",
        path: "issue/ENG-1/comment",
        query: { expand: "a b" },
        body: { x: 1 },
      }),
    ).toEqual({ ok: true });
    const [req] = sent;
    expect(req?.url).toBe(
      `${mode.base}/rest/api/3/issue/ENG-1/comment?expand=a+b`,
    );
    const headers = req?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(mode.header);
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(req?.init.body).toBe('{"x":1}');
    expect(req?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads an empty answer as null", async () => {
    const { impl } = fake(204, "");
    expect(
      await httpTransport(
        mode.base,
        credential,
        impl,
      )({ method: "PUT", path: "issue/ENG-1" }),
    ).toBeNull();
  });

  it("limits the credential by one key and bounds an absurd Retry-After", async () => {
    const keys: string[] = [];
    const limits: number[] = [];
    const governor = {
      admit: (_adapter: string, key: string) => void keys.push(key),
      observe: (key: string, answer: { limitedUntil?: number }) => {
        keys.push(key);
        limits.push(answer.limitedUntil ?? 0);
      },
    };
    const call = (retryAfter: string) =>
      httpTransport(
        mode.base,
        credential,
        fake(429, "", { "Retry-After": retryAfter }).impl,
        governor,
      )({ method: "GET", path: "x" }).catch((e: unknown) => e);
    const before = Date.now();
    await call("1e13");
    await call("30");
    expect(new Set(keys).size).toBe(1);
    expect(limits[0]).toBeLessThanOrEqual(before + 24 * 3_600_000 + 5_000);
    expect(() => new Date(limits[0] ?? 0).toISOString()).not.toThrow();
    expect(limits[1]).toBeLessThan(before + 60_000);
  });

  it("admits once per request sent", async () => {
    const admitted: string[] = [];
    const governor = {
      admit: (_adapter: string, key: string) => void admitted.push(key),
      observe: () => undefined,
    };
    const transport = httpTransport(
      mode.base,
      credential,
      fake(200, "{}").impl,
      governor,
    );
    await transport({ method: "GET", path: "x" });
    await transport({ method: "GET", path: "x" });
    expect(admitted.length).toBe(2);
  });

  it("maps statuses and carries Jira's error body", async () => {
    const fail = async (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ) =>
      (await httpTransport(
        mode.base,
        credential,
        fake(status, body, headers).impl,
      )({ method: "GET", path: "x" }).catch((e: unknown) => e)) as JiraApiError;
    const missing = await fail(
      404,
      '{"errorMessages":["Issue does not exist"],"errors":{}}',
    );
    expect([missing.notFound, missing.unavailable, missing.message]).toEqual([
      true,
      false,
      "Jira API HTTP 404 on GET x: Issue does not exist",
    ]);
    const limited = await fail(429, "slow down", { "Retry-After": "7" });
    expect([limited.unavailable, limited.retryAfterSec]).toEqual([true, 7]);
    expect((await fail(401, "")).unavailable).toBe(true);
    expect((await fail(503, "")).unavailable).toBe(true);
    const invalid = await fail(
      400,
      '{"errorMessages":[],"errors":{"customfield_1":"is required"}}',
    );
    expect([invalid.unavailable, invalid.errors, invalid.message]).toEqual([
      false,
      { customfield_1: "is required" },
      "Jira API HTTP 400 on GET x: customfield_1: is required",
    ]);
  });

  it("starts no request once the signal is aborted, and ends one in flight", async () => {
    const { sent, impl } = fake(200, "{}");
    const abort = new AbortController();
    abort.abort(new Error("stop"));
    await expect(
      httpTransport(
        mode.base,
        credential,
        impl,
      )({ method: "GET", path: "x" }, abort.signal),
    ).rejects.toThrow("cancelled: stop");
    expect(sent).toEqual([]);
    const hanging = (async (_: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      )) as typeof fetch;
    const later = new AbortController();
    const pending = httpTransport(
      mode.base,
      credential,
      hanging,
    )({ method: "GET", path: "x" }, later.signal);
    later.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("cancelled: deadline");
  });

  it("needs both halves of the Basic pair, failing at the first request", async () => {
    expect(resolveJiraCredential({ JIRA_EMAIL: "a@example.com" })).toEqual({
      ok: false,
      failure: {
        code: "no-credential",
        reason:
          "no Jira credential: set JIRA_BEARER_TOKEN to an OAuth access token, JIRA_TOKEN_COMMAND to a command that prints one, or JIRA_EMAIL and JIRA_API_TOKEN to an Atlassian account's email and API token",
      },
    });
    expect(
      resolveJiraCredential({
        JIRA_EMAIL: " a@example.com ",
        JIRA_API_TOKEN: "t",
      }),
    ).toEqual({
      ok: true,
      value: { kind: "basic", email: "a@example.com", token: "t" },
    });
    const err = (await defaultTransport(
      mode.base,
      {},
    )({ method: "GET", path: "myself" }).catch(
      (e: unknown) => e,
    )) as JiraApiError;
    expect([err.unavailable, err.message]).toEqual([
      true,
      "no Jira credential: set JIRA_BEARER_TOKEN to an OAuth access token, JIRA_TOKEN_COMMAND to a command that prints one, or JIRA_EMAIL and JIRA_API_TOKEN to an Atlassian account's email and API token",
    ]);
  });
});

describe("Jira request budget across credential modes", () => {
  const status = (code: number, headers: Record<string, string> = {}) =>
    (async () =>
      new Response(code === 200 ? "{}" : "", {
        status: code,
        headers,
      })) as unknown as typeof fetch;
  const bearer = (token: string) =>
    jiraAuthorization({ kind: "bearer", token });
  const command = (token: string) =>
    jiraAuthorization(
      { kind: "command", argv: ["broker", "token"] },
      { runner: async () => tokenRun(`${token}\n`) },
    );

  it("shares one budget between a direct Bearer token and a command returning it", async () => {
    const governor = budgetGovernor(memoryBudgetStore());
    await httpTransport(
      GATEWAY,
      bearer("same-t0ken"),
      status(429, { "Retry-After": "300" }),
      governor,
    )({ method: "GET", path: "x" }).catch(() => undefined);

    let sent = 0;
    const counting = (async () => {
      sent += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const refused = await httpTransport(
      GATEWAY,
      command("same-t0ken"),
      counting,
      governor,
    )({ method: "GET", path: "x" }).catch((e: unknown) => e);
    expect(isRateLimited(refused)).toBe(true);
    expect(sent).toBe(0);
  });

  it("keeps a different token independent", async () => {
    const governor = budgetGovernor(memoryBudgetStore());
    await httpTransport(
      GATEWAY,
      bearer("one"),
      status(429, { "Retry-After": "300" }),
      governor,
    )({ method: "GET", path: "x" }).catch(() => undefined);
    const answer = await httpTransport(
      GATEWAY,
      command("two"),
      status(200),
      governor,
    )({ method: "GET", path: "x" });
    expect(answer).toEqual({});
  });
});

describe("Jira pagers", () => {
  const paged =
    (pages: unknown[]): JiraTransport =>
    async (req) =>
      pages[
        req.path === "search/jql"
          ? pages.findIndex(
              (_, i) =>
                i ===
                Number(
                  (req.body as { nextPageToken?: string }).nextPageToken ?? 0,
                ),
            )
          : Number(req.query?.startAt ?? 0) / 2
      ];

  it("reads offset pages to isLast or total", async () => {
    const t = paged([
      { values: [{ id: 1 }, { id: 2 }], startAt: 0, total: 3 },
      { values: [{ id: 3 }], startAt: 2, total: 3 },
    ]);
    const all = await offsetPages(
      t,
      { method: "GET", path: "p" },
      { items: "values", idOf: (v) => v.id, where: "p" },
    );
    expect(all.map((v) => v.id)).toEqual([1, 2, 3]);
  });

  it("fails an offset read that repeats an item, says nothing of its end, or stalls", async () => {
    const read = (pages: unknown[]) =>
      offsetPages(
        paged(pages),
        { method: "GET", path: "p" },
        { items: "values", idOf: (v) => v.id, where: "p" },
      );
    await expect(
      read([
        { values: [{ id: 1 }, { id: 2 }], isLast: false },
        { values: [{ id: 2 }], isLast: true },
      ]),
    ).rejects.toThrow("2 repeated");
    await expect(read([{ values: [{ id: 1 }] }])).rejects.toThrow(
      "neither isLast nor total",
    );
    await expect(read([{ values: [], isLast: false }])).rejects.toThrow(
      "empty page",
    );
    await expect(read([{ items: [] }])).rejects.toThrow("no values list");
  });

  it("reads search pages by token and fails a repeated key or a missing isLast", async () => {
    const issue = (key: string) => ({ key, fields: {} });
    const search = (pages: unknown[]) =>
      searchPages(paged(pages), "project = ENG", ["summary"], "s");
    expect(
      (
        await search([
          { issues: [issue("ENG-1")], nextPageToken: "1", isLast: false },
          { issues: [issue("ENG-2")], isLast: true },
        ])
      ).map((i) => i.key),
    ).toEqual(["ENG-1", "ENG-2"]);
    await expect(
      search([
        { issues: [issue("ENG-1")], nextPageToken: "1", isLast: false },
        { issues: [issue("ENG-1")], isLast: true },
      ]),
    ).rejects.toThrow("ENG-1 repeated");
    await expect(search([{ issues: [], nextPageToken: "1" }])).rejects.toThrow(
      "whether it is the last",
    );
    await expect(
      search([{ issues: [], nextPageToken: "0", isLast: false }]),
    ).rejects.toThrow("repeated");
  });

  it("asks for a page of 100 with the fields and the token", async () => {
    const bodies: unknown[] = [];
    const t: JiraTransport = async (req) => {
      bodies.push(req.body);
      return bodies.length === 1
        ? { issues: [], nextPageToken: "abc", isLast: false }
        : { issues: [], isLast: true };
    };
    await searchPages(t, "project = ENG", ["summary"], "s");
    expect(bodies).toEqual([
      { jql: "project = ENG", fields: ["summary"], maxResults: 100 },
      {
        jql: "project = ENG",
        fields: ["summary"],
        maxResults: 100,
        nextPageToken: "abc",
      },
    ]);
  });
});

describe("Jira timestamps", () => {
  it("reads Jira's +0000 form as UTC", () => {
    expect(iso("2026-10-31T12:34:56.000+0000", "t")).toBe(
      "2026-10-31T12:34:56.000Z",
    );
    expect(iso("2026-10-31T12:34:56.000-0530", "t")).toBe(
      "2026-10-31T18:04:56.000Z",
    );
    expect(() => iso("yesterday", "t")).toThrow("not a timestamp");
  });
});
