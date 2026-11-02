import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import { TrackerConfigError } from "../scripts/lib/tracker/config-error.ts";
import { openTracker } from "../scripts/lib/tracker/index.ts";
import { iso } from "../scripts/lib/tracker/jira/read.ts";
import { parseJiraSettings } from "../scripts/lib/tracker/jira/settings.ts";
import {
  defaultTransport,
  httpTransport,
  type JiraApiError,
  type JiraTransport,
  offsetPages,
  resolveJiraCredential,
  searchPages,
} from "../scripts/lib/tracker/jira/transport.ts";
import { SITE } from "./jira-fixtures.ts";

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
        blocks: "Blocks",
        related: "Relates",
        duplicate: "Duplicate",
      },
    });
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
    expect(s.linkTypes.blocks).toBe("Blocks");
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

describe("Jira transport", () => {
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
  const credential = { email: "factory@example.com", token: "t0ken" };

  it("does not follow redirects with the credential", async () => {
    const { sent, impl } = fake(302, "", {
      location: "https://other.example/",
    });
    await expect(
      httpTransport(SITE, credential, impl)({ method: "GET", path: "myself" }),
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
        SITE,
        credential,
        impl,
      )({
        method: "POST",
        path: "issue/ENG-1/comment",
        body: {},
      }),
    ).rejects.toMatchObject({ answerLost: true, status: 201 });
  });

  it("sends Basic authentication, JSON and the query under /rest/api/3", async () => {
    const { sent, impl } = fake(200, '{"ok":true}');
    const t = httpTransport(SITE, credential, impl);
    expect(
      await t({
        method: "POST",
        path: "issue/ENG-1/comment",
        query: { expand: "a b" },
        body: { x: 1 },
      }),
    ).toEqual({ ok: true });
    const [req] = sent;
    expect(req?.url).toBe(`${SITE}/rest/api/3/issue/ENG-1/comment?expand=a+b`);
    const headers = req?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("factory@example.com:t0ken").toString("base64")}`,
    );
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(req?.init.body).toBe('{"x":1}');
    expect(req?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("reads an empty answer as null", async () => {
    const { impl } = fake(204, "");
    expect(
      await httpTransport(
        SITE,
        credential,
        impl,
      )({ method: "PUT", path: "issue/ENG-1" }),
    ).toBeNull();
  });

  it("maps statuses and carries Jira's error body", async () => {
    const fail = async (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ) =>
      (await httpTransport(
        SITE,
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
        SITE,
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
      SITE,
      credential,
      hanging,
    )({ method: "GET", path: "x" }, later.signal);
    later.abort(new Error("deadline"));
    await expect(pending).rejects.toThrow("cancelled: deadline");
  });

  it("needs both halves of the credential, failing at the first request", async () => {
    expect(resolveJiraCredential({ JIRA_EMAIL: "a@example.com" })).toBeNull();
    expect(
      resolveJiraCredential({
        JIRA_EMAIL: " a@example.com ",
        JIRA_API_TOKEN: "t",
      }),
    ).toEqual({
      email: "a@example.com",
      token: "t",
    });
    const err = (await defaultTransport(
      SITE,
      {},
    )({ method: "GET", path: "myself" }).catch(
      (e: unknown) => e,
    )) as JiraApiError;
    expect([err.unavailable, err.message]).toEqual([
      true,
      "JIRA_EMAIL and JIRA_API_TOKEN must hold an Atlassian account's email and API token",
    ]);
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
