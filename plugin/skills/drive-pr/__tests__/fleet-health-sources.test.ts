/**
 * fleet-health-sources.test.ts — the sensor's I/O layer, against a
 * fake `gh` and the Linear tracker adapter over a fake transport.
 *
 * Each of these guards a way an INPUT could shrink or lie without the report
 * saying so, which is the failure that matters most in a tool whose whole value
 * is honesty:
 *
 *  - the REST listing's paging, stop condition and cap;
 *  - the GraphQL budget probe, which must read an exhausted budget as 0 (the REST
 *    `rate_limit` endpoint was measured reporting ample budget while GraphQL was
 *    refusing);
 *  - a file listing at GitHub's cap, which is a prefix and must fail;
 *  - the verdict recognizer (last line, newest wins, trusted authors only);
 *  - tracker reads, which must fail on an unreadable node rather than drop it;
 *  - the change-area classifier over a fixture catalog.
 *
 * No network.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseTrackerConfig } from "../../do-issue/scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
  parseIssueFact,
} from "../../do-issue/scripts/lib/tracker/linear.ts";
import type { Tracker } from "../../do-issue/scripts/lib/tracker/port.ts";
import { parseConfig } from "../scripts/lib/fleet-health-config.ts";
import {
  fetchAcceptedEpics,
  fetchEpicActivity,
  fetchEpicComments,
  fetchIssuesByIds,
  fetchPrBody,
  fetchPrFiles,
  type Gh,
  GITHUB_FILE_CAP,
  graphqlBudget,
  listCandidatePrs,
  globToRegExp,
  loadCatalogFile,
  makeClassifier,
} from "../scripts/lib/fleet-health-sources.ts";

const REPO = { owner: "o", name: "r" };
const DAY = 86_400_000;
const WIN = {
  sinceMs: Date.parse("2026-09-01T00:00:00Z"),
  untilMs: Date.parse("2026-09-15T00:00:00Z"),
};

function ok(stdout: string) {
  return {
    code: 0,
    stdout,
    stderr: "",
    timedOut: false,
    bufferExceeded: false,
    spawnFailed: false,
  };
}
function bad(code = 1) {
  return {
    code,
    stdout: "",
    stderr: "",
    timedOut: false,
    bufferExceeded: false,
    spawnFailed: false,
  };
}
function gh(handler: (args: string[]) => ReturnType<typeof ok>): Gh {
  return (async (args: string[]) => handler(args)) as unknown as Gh;
}

function rest(number: number, over: Record<string, unknown> = {}) {
  return {
    number,
    title: `pr ${number}`,
    body: "",
    state: "closed",
    created_at: "2026-09-05T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    closed_at: "2026-09-10T00:00:00Z",
    merged_at: null,
    ...over,
  };
}

describe("listCandidatePrs (REST)", () => {
  it("keeps PRs that existed during the window and drops those closed before it or created after it", async () => {
    const rows = [
      rest(1),
      rest(2, {
        closed_at: "2026-08-01T00:00:00Z",
        updated_at: "2026-09-02T00:00:00Z",
      }),
      rest(3, { created_at: "2026-09-20T00:00:00Z" }),
      rest(4, { state: "open", closed_at: null }),
      rest(5, { merged_at: "2026-09-11T00:00:00Z" }),
    ];
    const c = await listCandidatePrs(
      REPO,
      WIN,
      100,
      gh(() => ok(JSON.stringify(rows))),
    );
    expect(c.prs.map((p) => p.number).sort()).toEqual([1, 4, 5]);
    expect(c.prs.find((p) => p.number === 5)?.state).toBe("MERGED");
    expect(c.prs.find((p) => p.number === 4)?.state).toBe("OPEN");
    expect(c.prs.find((p) => p.number === 1)?.state).toBe("CLOSED");
    expect(c.capped).toBe(false);
  });

  it("stops paging at the first page that ends behind the window", async () => {
    const pages: number[] = [];
    const full = (start: number, updated: string) =>
      Array.from({ length: 100 }, (_, i) =>
        rest(start + i, { updated_at: updated }),
      );
    const c = await listCandidatePrs(
      REPO,
      WIN,
      1000,
      gh((args) => {
        const page = Number(/[&?]page=(\d+)/.exec(args[1] ?? "")?.[1]);
        pages.push(page);
        return ok(
          JSON.stringify(
            page === 1
              ? full(1000, "2026-09-10T00:00:00Z")
              : full(2000, "2026-08-01T00:00:00Z"),
          ),
        );
      }),
    );
    // pages 1 and 2 to reach the window's edge, then page 1 again for anything
    // updated while the walk ran
    expect(pages).toEqual([1, 2, 1]);
    expect(c.prs.length).toBeGreaterThan(0);
  });

  it("reports itself capped when the page cap or the limit bites, rather than truncating quietly", async () => {
    const always = gh(() =>
      ok(
        JSON.stringify(
          Array.from({ length: 100 }, (_, i) =>
            rest(i + 1, { updated_at: "2026-09-10T00:00:00Z" }),
          ),
        ),
      ),
    );
    const cappedByPages = await listCandidatePrs(REPO, WIN, 1_000_000, always);
    expect(cappedByPages.capped).toBe(true);
    const cappedByLimit = await listCandidatePrs(
      REPO,
      WIN,
      3,
      gh(() => ok(JSON.stringify([rest(1), rest(2), rest(3), rest(4)]))),
    );
    expect(cappedByLimit.capped).toBe(true);
    expect(cappedByLimit.prs).toHaveLength(3);
  });

  it("fails on an unreadable page or row instead of returning a shorter population", async () => {
    await expect(
      listCandidatePrs(
        REPO,
        WIN,
        10,
        gh(() => bad()),
      ),
    ).rejects.toThrow(/failed on page 1/);
    await expect(
      listCandidatePrs(
        REPO,
        WIN,
        10,
        gh(() => ok("{oops")),
      ),
    ).rejects.toThrow(/unparsable/);
    await expect(
      listCandidatePrs(
        REPO,
        WIN,
        10,
        gh(() => ok("{}")),
      ),
    ).rejects.toThrow(/not an array/);
    await expect(
      listCandidatePrs(
        REPO,
        WIN,
        10,
        gh(() => ok(JSON.stringify([rest(1, { created_at: undefined })]))),
      ),
    ).rejects.toThrow(/not a timestamp/);
    await expect(
      listCandidatePrs(
        REPO,
        WIN,
        10,
        gh(() => ok(JSON.stringify([{ title: "x" }]))),
      ),
    ).rejects.toThrow(/no usable PR number/);
  });
});

describe("listCandidatePrs — malformed REST rows fail the read", () => {
  const rejects = (over: Record<string, unknown>, re: RegExp) =>
    expect(
      listCandidatePrs(
        REPO,
        WIN,
        10,
        gh(() => ok(JSON.stringify([rest(1, over)]))),
      ),
    ).rejects.toThrow(re);

  it("rejects a non-string or unparseable merged_at/closed_at instead of reading it as null", async () => {
    await rejects({ merged_at: 12345 }, /merged_at is not a timestamp/);
    await rejects({ closed_at: "soon" }, /closed_at is not a timestamp/);
  });

  it("rejects an ABSENT merged_at/closed_at — REST sends an explicit null, never omits the key", async () => {
    for (const field of ["merged_at", "closed_at"]) {
      const row: Record<string, unknown> = rest(1, {});
      delete row[field];
      await expect(
        listCandidatePrs(
          REPO,
          WIN,
          10,
          gh(() => ok(JSON.stringify([row]))),
        ),
      ).rejects.toThrow(new RegExp(`${field} is not a timestamp`));
    }
  });

  it("rejects an unparseable created_at/updated_at", async () => {
    await rejects({ created_at: "not-a-date" }, /not a timestamp/);
    await rejects({ updated_at: "yesterday" }, /not a timestamp/);
  });

  it("rejects a missing or unknown state instead of reading it as CLOSED", async () => {
    await rejects({ state: undefined }, /state is not open\/closed/);
    await rejects({ state: "draft" }, /state is not open\/closed/);
  });
});

describe("listCandidatePrs — a list that moves while it is read", () => {
  it("keeps one row per PR when a row reappears across a page boundary", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      rest(500 + i, { updated_at: "2026-09-10T00:00:00Z" }),
    );
    // the last row of page 1 shifted onto page 2 because something was updated meanwhile
    const page2 = [
      page1[99],
      rest(9, {
        updated_at: "2026-08-01T00:00:00Z",
        closed_at: "2026-08-01T00:00:00Z",
      }),
    ];
    const c = await listCandidatePrs(
      REPO,
      WIN,
      1000,
      gh((args) =>
        ok(JSON.stringify(/[&?]page=1$/.test(args[1] ?? "") ? page1 : page2)),
      ),
    );
    expect(c.prs.filter((p) => p.number === 599)).toHaveLength(1);
    expect(new Set(c.prs.map((p) => p.number)).size).toBe(c.prs.length);
  });

  it("picks up a PR updated mid-walk that moved in front of the page already read", async () => {
    let call = 0;
    const late = rest(777, {
      state: "open",
      closed_at: null,
      updated_at: "2026-09-14T00:00:00Z",
    });
    const c = await listCandidatePrs(
      REPO,
      WIN,
      1000,
      gh(() => {
        call++;
        // first read of page 1 predates the update; the final re-read of page 1 has it
        return ok(JSON.stringify(call === 1 ? [rest(1)] : [late, rest(1)]));
      }),
    );
    expect(c.prs.map((p) => p.number).sort((a, b) => a - b)).toEqual([1, 777]);
  });

  it("keeps a PR the final page-one reread pulled in even when the walk already filled the limit", async () => {
    let call = 0;
    const late = rest(777, {
      state: "open",
      closed_at: null,
      updated_at: "2026-09-14T00:00:00Z",
    });
    const c = await listCandidatePrs(
      REPO,
      WIN,
      2,
      gh(() => {
        call++;
        return ok(
          JSON.stringify(
            call === 1 ? [rest(1), rest(2)] : [late, rest(1), rest(2)],
          ),
        );
      }),
    );
    expect(c.capped).toBe(true);
    expect(c.prs.map((p) => p.number)).toContain(777);
    expect(c.prs).toHaveLength(2);
  });

  it("does not treat an old, idle open PR as activity in the window", async () => {
    const idle = rest(8, {
      state: "open",
      closed_at: null,
      updated_at: "2026-08-01T00:00:00Z",
    });
    const c = await listCandidatePrs(
      REPO,
      WIN,
      100,
      gh(() => ok(JSON.stringify([idle]))),
    );
    expect(c.prs).toEqual([]);
  });
});

describe("graphqlBudget", () => {
  it("reads the remaining budget from GraphQL itself", async () => {
    const b = await graphqlBudget(
      gh(() =>
        ok(
          JSON.stringify({
            data: {
              rateLimit: { remaining: 4200, resetAt: "2026-09-29T14:44:28Z" },
            },
          }),
        ),
      ),
    );
    expect(b).toEqual({ remaining: 4200, resetAt: "2026-09-29T14:44:28Z" });
  });

  it("reads an exhausted budget, which answers with a RATE_LIMIT error, as 0 remaining", async () => {
    const b = await graphqlBudget(
      gh(() =>
        ok(
          JSON.stringify({
            errors: [
              {
                type: "RATE_LIMIT",
                message: "API rate limit already exceeded",
              },
            ],
          }),
        ),
      ),
    );
    expect(b?.remaining).toBe(0);
  });

  it("answers null — not a healthy number — when the probe is unreadable", async () => {
    expect(await graphqlBudget(gh(() => ok("nope")))).toBeNull();
    expect(
      await graphqlBudget(gh(() => ok(JSON.stringify({ data: {} })))),
    ).toBeNull();
  });
});

describe("fetchPrFiles", () => {
  it("parses added and deleted lines per file", async () => {
    const files = await fetchPrFiles(
      REPO,
      7,
      gh(() => ok("a.ts\t3\t1\nb/c.md\t0\t9\n")),
    );
    expect(files).toEqual([
      { path: "a.ts", additions: 3, deletions: 1 },
      { path: "b/c.md", additions: 0, deletions: 9 },
    ]);
  });

  it("fails at GitHub's file cap, where the list is a truncated prefix", async () => {
    const rows = Array.from(
      { length: GITHUB_FILE_CAP },
      (_, i) => `f${i}.ts\t1\t0`,
    ).join("\n");
    await expect(
      fetchPrFiles(
        REPO,
        7,
        gh(() => ok(rows)),
      ),
    ).rejects.toThrow(/truncated/);
  });

  it("fails on an unreadable row or command rather than skipping it", async () => {
    await expect(
      fetchPrFiles(
        REPO,
        7,
        gh(() => ok("a.ts\tx\t1")),
      ),
    ).rejects.toThrow(/unreadable file row/);
    // An empty numstat field is 0 to `Number('')`, so it must be refused by shape.
    for (const row of ["a.ts\t\t1", "a.ts\t1\t", "a.ts\t-\t-", "a.ts\t 1\t1"]) {
      await expect(
        fetchPrFiles(
          REPO,
          7,
          gh(() => ok(row)),
        ),
      ).rejects.toThrow(/unreadable file row/);
    }
    await expect(
      fetchPrFiles(
        REPO,
        7,
        gh(() => bad()),
      ),
    ).rejects.toThrow(/could not list/);
  });
});

describe("the change-area classifier", () => {
  const FIXTURES = join(import.meta.dir, "fixtures");
  const raw = {
    version: 1,
    window: { days: 14 },
    progress: {
      product_areas: ["api", "web"],
      weights: { merged_product_pr: 1, criterion_closed: 1, epic_accepted: 1 },
    },
    ceremony: {
      free_rounds: 3,
      weights: {
        rounds_beyond_free: 1,
        followups_minted: 1,
        sdlc_issues_opened: 1,
      },
      unmeasured: { handoffs: "no durable record" },
    },
    signals: {
      stuck_epic: { days: 14 },
      ceremony_ratio: { suspect_at: 5, high_at: 10, min_ceremony: 5 },
      followup_depth: { suspect_at: 2, max_walk: 6 },
      delivery_system_share: { suspect_at: null },
      review_carousel: {
        min_rounds: 12,
        high_rounds: 25,
        min_post_review_share: 0.45,
      },
    },
    lifecycle: { cooldown_days: 14 },
    labels: { delivery_system: "delivery-system" },
  };
  const cfg = {
    ...parseConfig(raw),
    catalogPath: join(FIXTURES, "change-areas-catalog.yaml"),
  };

  it("knows a delivery-system area from the catalog and claims .claude/skills/** is not yet one", async () => {
    const c = await makeClassifier(cfg);
    const r = c.classify([
      { path: "src/api/routes/x.ts", additions: 10, deletions: 0 },
      { path: "tools/delivery/foo.ts", additions: 5, deletions: 5 },
      {
        path: ".claude/skills/drive-pr/scripts/x.ts",
        additions: 7,
        deletions: 3,
      },
    ]);
    expect(r.productPr).toBe(true);
    expect(r.deliveryLines).toBe(10);
    expect(r.unclaimedSkillLines).toBe(10);
    expect(r.totalLines).toBe(30);
  });

  it("does not count a PR touching only delivery-system files as product progress", async () => {
    const c = await makeClassifier(cfg);
    expect(
      c.classify([
        { path: "tools/delivery/foo.ts", additions: 1, deletions: 0 },
      ]).productPr,
    ).toBe(false);
  });

  it("reads generated sources and the nested tracker-label form", () => {
    const catalog = loadCatalogFile(cfg.catalogPath);
    expect(catalog.get("api")?.globs).toContain("tools/codegen/**");
    expect(catalog.get("ci")?.labels).toEqual(["delivery-system"]);
  });

  it("reports an unconfigured catalog, an unknown product area and a missing delivery label", async () => {
    await expect(makeClassifier({ ...cfg, catalogPath: null })).rejects.toThrow(
      /drive.change_areas_catalog/,
    );
    await expect(
      makeClassifier({
        ...cfg,
        progress: { ...cfg.progress, productAreas: ["api", "mobile"] },
      }),
    ).rejects.toThrow(/mobile/);
    await expect(
      makeClassifier({
        ...cfg,
        labels: { ...cfg.labels, deliverySystem: "nope" },
      }),
    ).rejects.toThrow(/'nope'/);
    const noDelivery = await makeClassifier({
      ...cfg,
      labels: { ...cfg.labels, deliverySystem: null },
    });
    expect(
      noDelivery.classify([
        { path: "tools/delivery/foo.ts", additions: 4, deletions: 0 },
      ]).deliveryLines,
    ).toBe(0);
  });

  it("matches globs across segments, within one segment, and on dotfiles", () => {
    expect(globToRegExp("src/**").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/x.ts").test("src/x.ts")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("**/*.md").test(".github/README.md")).toBe(true);
    expect(globToRegExp("a/{b,c}/*.ts").test("a/c/d.ts")).toBe(true);
    expect(globToRegExp("a/[xy].ts").test("a/y.ts")).toBe(true);
    expect(globToRegExp("a.b").test("aXb")).toBe(false);
  });
});

// ── The issue tracker ───────────────────────────────────────────────────────

const STATES = parseTrackerConfig({}).states;

function trackerFor(graphql: LinearTransport): Tracker {
  return port(graphql);
}

function port(graphql: LinearTransport): Tracker {
  return linearTracker({ team: "ENG", states: STATES, transport: graphql });
}

describe("fetchAcceptedEpics", () => {
  const comment = (epic: string, verdict: string, at: string, tail = "") => ({
    body: `Verdict.\n<!-- epic-acceptance-verdict: ${verdict} -->${tail}`,
    createdAt: at,
    issue: { identifier: epic },
    user: { id: "u1", guest: false },
  });
  const run = (nodes: unknown[]) =>
    fetchAcceptedEpics(
      port(async () => ({
        comments: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
      })),
      WIN,
      "epic",
    );

  it("counts ACCEPT and ACCEPT-WITH-FOLLOWUPS, not REJECT", async () => {
    const got = await run([
      comment("ENG-1", "ACCEPT", "2026-09-05T00:00:00Z"),
      comment("ENG-2", "ACCEPT-WITH-FOLLOWUPS", "2026-09-05T00:00:00Z"),
      comment("ENG-3", "REJECT", "2026-09-05T00:00:00Z"),
    ]);
    expect([...got].sort()).toEqual(["ENG-1", "ENG-2"]);
  });

  it("lets a later REJECT override an earlier ACCEPT — the newest verdict decides", async () => {
    const got = await run([
      comment("ENG-1", "ACCEPT", "2026-09-05T00:00:00Z"),
      comment("ENG-1", "REJECT", "2026-09-09T00:00:00Z"),
    ]);
    expect(got.size).toBe(0);
  });

  it("ignores a comment that merely quotes a verdict marker (it must be the LAST line)", async () => {
    const quoted = {
      body: "Quoting for context: <!-- epic-acceptance-verdict: ACCEPT -->\n\nand more prose",
      createdAt: "2026-09-05T00:00:00Z",
      issue: { identifier: "ENG-1" },
      user: { id: "u1", guest: false },
    };
    expect((await run([quoted])).size).toBe(0);
  });

  it("ignores a verdict from a guest or an unresolvable author — the marker is forgeable text", async () => {
    const forged = (user: unknown) => ({
      ...comment("ENG-1", "ACCEPT", "2026-09-05T00:00:00Z"),
      user,
    });
    expect((await run([forged({ id: "g", guest: true })])).size).toBe(0);
    expect((await run([forged(null)])).size).toBe(0);
    expect((await run([forged(undefined)])).size).toBe(0);
    // `fetchEpicComments` requires a string id too: an id-less non-guest is untrusted.
    expect((await run([forged({ guest: false })])).size).toBe(0);
    expect((await run([forged({ id: 7, guest: false })])).size).toBe(0);
  });

  it("resolves an equal-createdAt tie the same way in either order, REJECT winning", async () => {
    const at = "2026-09-05T00:00:00Z";
    const a = comment("ENG-1", "ACCEPT", at);
    const r = comment("ENG-1", "REJECT", at);
    expect((await run([a, r])).size).toBe(0);
    expect((await run([r, a])).size).toBe(0);
  });

  it("asks the tracker only for this team’s epic-labelled issues", async () => {
    let seen: unknown;
    await fetchAcceptedEpics(
      port(async (_q, v) => {
        seen = v.filter;
        return {
          comments: {
            nodes: [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }),
      WIN,
      "epic",
    );
    expect((seen as { issue: unknown }).issue).toEqual({
      team: { key: { eq: "ENG" } },
      labels: { name: { eq: "epic" } },
    });
  });
});

describe("tracker reads fail closed", () => {
  it("rejects a comment node it cannot read, since the dropped one could be the marker", async () => {
    const graphql: LinearTransport = async () => ({
      issue: {
        id: "uuid-1",
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { body: "ok", createdAt: "2026-09-01T00:00:00Z" },
            { body: 7 },
          ],
        },
      },
    });
    await expect(fetchEpicComments(port(graphql), "ENG-1")).rejects.toThrow(
      /unreadable comment node/,
    );
  });

  it("rejects a comment whose createdAt is unparseable, since lifecycle ordering and cooldown parse it", async () => {
    const graphql: LinearTransport = async () => ({
      issue: {
        id: "uuid-1",
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ body: "ok", createdAt: "not-a-date" }],
        },
      },
    });
    await expect(fetchEpicComments(port(graphql), "ENG-1")).rejects.toThrow(
      /unreadable comment node/,
    );
  });

  it("marks a comment trusted only for a non-guest user that resolves", async () => {
    const node = (user: unknown) => ({
      body: "b",
      createdAt: "2026-09-01T00:00:00Z",
      user,
    });
    const graphql: LinearTransport = async () => ({
      issue: {
        id: "uuid-1",
        comments: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            node({ id: "u1", guest: false }),
            node({ id: "u2", guest: true }),
            node(null),
            { body: "b", createdAt: "2026-09-01T00:00:00Z" },
          ],
        },
      },
    });
    const got = await fetchEpicComments(port(graphql), "ENG-1");
    expect(got.comments.map((c) => c.trusted)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it("rejects an unreadable verdict node, since a skipped one could be the newest ACCEPT", async () => {
    await expect(
      fetchAcceptedEpics(
        port(async () => ({
          comments: {
            nodes: [{ body: "x", createdAt: "2026-09-01T00:00:00Z" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        })),
        WIN,
        "epic",
      ),
    ).rejects.toThrow(/unreadable node/);
  });

  it("returns every comment and the UUID across pages", async () => {
    let call = 0;
    const graphql: LinearTransport = async () => {
      call++;
      return {
        issue: {
          id: "uuid-1",
          comments: {
            pageInfo: {
              hasNextPage: call === 1,
              endCursor: call === 1 ? "c1" : null,
            },
            nodes: [
              { body: `page ${call}`, createdAt: "2026-09-01T00:00:00Z" },
            ],
          },
        },
      };
    };
    const got = await fetchEpicComments(port(graphql), "ENG-1");
    expect(got.uuid).toBe("uuid-1");
    expect(got.comments.map((c) => c.body)).toEqual(["page 1", "page 2"]);
  });

  it("fails on a repeated pagination cursor rather than looping or stopping short", async () => {
    const graphql: LinearTransport = async () => ({
      issues: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } },
    });
    await expect(fetchIssuesByIds(port(graphql), ["ENG-1"])).rejects.toThrow(
      /cursor missing or repeated/,
    );
  });

  it("refuses an issue node whose creation time does not parse", () => {
    expect(() =>
      parseIssueFact({
        identifier: "ENG-1",
        createdAt: "not-a-date",
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        state: { type: "started" },
      }),
    ).toThrow(/createdAt is malformed/);
  });

  it("fails the read when an issue repeats across a page boundary", async () => {
    let call = 0;
    const graphql: LinearTransport = async () => {
      call += 1;
      return {
        issues: {
          nodes: [{ identifier: "ENG-1" }],
          pageInfo: {
            hasNextPage: call === 1,
            endCursor: call === 1 ? "c1" : null,
          },
        },
      };
    };
    await expect(fetchIssuesByIds(port(graphql), ["ENG-1"])).rejects.toThrow(
      /repeated across pages/,
    );
  });

  it("refuses an issue node without a creation time instead of defaulting it into the past", () => {
    expect(() =>
      parseIssueFact({
        identifier: "ENG-1",
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        state: { type: "started" },
      }),
    ).toThrow(/createdAt/);
  });

  it("refuses an issue whose title or description is present but not a string, and reads absent or null as empty", () => {
    const base = {
      identifier: "ENG-1",
      createdAt: "2026-09-01T00:00:00Z",
      state: { type: "started" },
      completedAt: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    expect(() => parseIssueFact({ ...base, title: 7 })).toThrow(
      /title is not a string/,
    );
    expect(() => parseIssueFact({ ...base, description: {} })).toThrow(
      /description is not a string/,
    );
    const empty = parseIssueFact({ ...base, description: null });
    expect(empty.description).toBe("");
    expect(parseIssueFact(base).title).toBe("");
  });

  it("refuses an issue or ancestor whose label connection is missing or malformed instead of reading it as no labels", () => {
    expect(() =>
      parseIssueFact({
        identifier: "ENG-1",
        createdAt: "2026-09-01T00:00:00Z",
        state: { type: "started" },
      }),
    ).toThrow(/labels/);
    expect(() =>
      parseIssueFact({
        identifier: "ENG-1",
        createdAt: "2026-09-01T00:00:00Z",
        labels: {
          nodes: [{ name: "epic" }, { nope: 1 }],
          pageInfo: { hasNextPage: false },
        },
      }),
    ).toThrow(/label node/);
    expect(() =>
      parseIssueFact({
        identifier: "ENG-1",
        createdAt: "2026-09-01T00:00:00Z",
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        parent: { identifier: "ENG-0" },
      }),
    ).toThrow(/ancestor ENG-0/);
  });

  it("refuses a present-but-unreadable parent instead of ending the ancestor walk early", () => {
    const base = {
      identifier: "ENG-1",
      createdAt: "2026-09-01T00:00:00Z",
      state: { type: "started" },
      completedAt: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
    };
    expect(() => parseIssueFact({ ...base, parent: {} })).toThrow(/ancestor/);
    expect(() =>
      parseIssueFact({ ...base, parent: { identifier: 3 } }),
    ).toThrow(/ancestor/);
    expect(() => parseIssueFact({ ...base, parent: "ENG-0" })).toThrow(
      /ancestor/,
    );
    expect(parseIssueFact({ ...base, parent: null }).ancestors).toEqual([]);
  });

  it("refuses a label list that may be a truncated prefix, or whose pageInfo is unreadable", () => {
    const base = {
      identifier: "ENG-1",
      createdAt: "2026-09-01T00:00:00Z",
      state: { type: "started" },
      completedAt: null,
    };
    expect(() =>
      parseIssueFact({
        ...base,
        labels: { nodes: [], pageInfo: { hasNextPage: true } },
      }),
    ).toThrow(/truncated/);
    expect(() => parseIssueFact({ ...base, labels: { nodes: [] } })).toThrow(
      /truncated or its pageInfo/,
    );
  });

  it("refuses an ancestry longer than the attribution walk can see", () => {
    const chain = (n: number): Record<string, unknown> | undefined =>
      n === 0
        ? undefined
        : {
            identifier: `ENG-${100 + n}`,
            labels: { nodes: [], pageInfo: { hasNextPage: false } },
            parent: chain(n - 1),
          };
    const issue = (depth: number) => ({
      identifier: "ENG-1",
      createdAt: "2026-09-01T00:00:00Z",
      state: { type: "started" },
      completedAt: null,
      labels: { nodes: [], pageInfo: { hasNextPage: false } },
      parent: chain(depth),
    });
    expect(parseIssueFact(issue(5)).ancestors).toHaveLength(5);
    expect(() => parseIssueFact(issue(6))).toThrow(/more than 5 ancestors/);
  });

  it("reads the ancestor chain nearest first, with labels", () => {
    const node = parseIssueFact({
      identifier: "ENG-5",
      createdAt: "2026-09-01T00:00:00Z",
      labels: {
        nodes: [{ name: "follow-up" }],
        pageInfo: { hasNextPage: false },
      },
      state: { type: "started" },
      completedAt: null,
      parent: {
        identifier: "ENG-4",
        labels: { nodes: [], pageInfo: { hasNextPage: false } },
        parent: {
          identifier: "ENG-3",
          labels: {
            nodes: [{ name: "epic" }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    });
    expect(node.ancestors).toEqual([
      { id: "ENG-4", labels: [] },
      { id: "ENG-3", labels: ["epic"] },
    ]);
    expect(DAY).toBeGreaterThan(0);
  });
});

describe("malformed source fields fail the read instead of reading as empty", () => {
  const issueNode = (over: Record<string, unknown>) => ({
    identifier: "ENG-1",
    createdAt: "2026-09-01T00:00:00Z",
    state: { type: "completed" },
    completedAt: "2026-09-10T00:00:00Z",
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    ...over,
  });

  it("rejects a REST pull whose body is present but not a string, and keeps a null body empty", async () => {
    const list = (body: unknown) =>
      listCandidatePrs(
        REPO,
        WIN,
        1000,
        gh(() => ok(JSON.stringify([rest(1, { body })]))),
      );
    await expect(list(42)).rejects.toThrow(/body is not a string/);
    // an ABSENT body is a malformed row, unlike GitHub's explicit null
    const { body: _absent, ...noBody } = rest(1);
    await expect(
      listCandidatePrs(
        REPO,
        WIN,
        1000,
        gh(() => ok(JSON.stringify([noBody]))),
      ),
    ).rejects.toThrow(/body is not a string/);
    expect((await list(null)).prs[0]?.body).toBe("");
  });

  it("reads a PR body as unreadable when it is missing or not a string, and empty when null", async () => {
    const read = (stdout: string) =>
      fetchPrBody(
        REPO,
        1,
        gh(() => ok(stdout)),
      );
    expect(await read('{"body":null}')).toBe("");
    expect(await read('{"body":"x"}')).toBe("x");
    expect(await read('{"body":7}')).toBeNull();
    expect(await read("{}")).toBeNull();
  });

  it("reads a PR body from the resolved repository, never the working directory's remotes", async () => {
    let seen: string[] = [];
    await fetchPrBody(
      REPO,
      7,
      gh((args) => {
        seen = args;
        return ok('{"body":"x"}');
      }),
    );
    const at = seen.indexOf("--repo");
    expect(at).toBeGreaterThan(-1);
    expect(seen[at + 1]).toBe("o/r");
  });

  it("refuses an issue with a malformed completedAt or an unreadable state type", () => {
    expect(() => parseIssueFact(issueNode({ completedAt: "nope" }))).toThrow(
      /completedAt/,
    );
    expect(() => parseIssueFact(issueNode({ completedAt: 5 }))).toThrow(
      /completedAt/,
    );
    expect(() => parseIssueFact(issueNode({ state: {} }))).toThrow(
      /state\.type/,
    );
    expect(
      parseIssueFact(issueNode({ completedAt: null })).completedAt,
    ).toBeNull();
    // ABSENT is not null: the field is requested, so an omitted key would
    // silently drop a progress unit.
    const { completedAt: _omitted, ...withoutCompletedAt } = issueNode({});
    expect(() => parseIssueFact(withoutCompletedAt)).toThrow(/completedAt/);
  });

  it("replaces a retained row with the fresher final page-one reread of the same PR", async () => {
    let call = 0;
    const c = await listCandidatePrs(
      REPO,
      WIN,
      1000,
      gh(() => {
        call++;
        return ok(
          JSON.stringify([
            call === 1
              ? rest(5, { body: "old" })
              : rest(5, { body: "new", updated_at: "2026-09-14T00:00:00Z" }),
          ]),
        );
      }),
    );
    expect(c.prs.find((p) => p.number === 5)?.body).toBe("new");
  });
});

describe("started epic activity census", () => {
  const epic = {
    id: "epic-id",
    identifier: "ENG-100",
    state: { type: "started" },
    startedAt: "2026-08-01T00:00:00Z",
  };
  const child = { identifier: "ENG-101", updatedAt: "2026-08-02T00:00:00Z" };
  const connection = (
    nodes: unknown[],
    more = false,
    cursor: string | null = null,
  ) => ({
    issues: { nodes, pageInfo: { hasNextPage: more, endCursor: cursor } },
  });
  it("pages child activity independently of the window, including completed children", async () => {
    const calls: Record<string, unknown>[] = [];
    const port = trackerFor(async (_query, vars) => {
      calls.push(vars);
      if ("parent" in (vars.filter as Record<string, unknown>))
        return vars.after === null
          ? connection([child], true, "next")
          : connection([
              { identifier: "ENG-102", updatedAt: "2026-08-03T00:00:00Z" },
            ]);
      return connection([epic]);
    });
    const result = await fetchEpicActivity(port, "epic");
    expect(result).toEqual([
      {
        epic: "ENG-100",
        startedAt: epic.startedAt,
        children: [
          child,
          { issue: "ENG-102", updatedAt: "2026-08-03T00:00:00Z" },
        ].map((c) =>
          "identifier" in c
            ? { issue: c.identifier, updatedAt: c.updatedAt }
            : c,
        ),
      },
    ]);
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.includeArchived)).toEqual([
      false,
      true,
      true,
    ]);
    expect(calls[0]?.filter).toEqual({
      team: { key: { eq: "ENG" } },
      labels: { name: { eq: "epic" } },
      state: { type: { eq: "started" } },
    });
  });
  it("stops the census before the next dispatch once the deadline fires", async () => {
    const controller = new AbortController();
    let calls = 0;
    const port = trackerFor(async () => {
      calls++;
      controller.abort();
      return connection([epic]);
    });
    await expect(
      fetchEpicActivity(port, "epic", controller.signal),
    ).rejects.toThrow("deadline");
    expect(calls).toBe(1);
  });
  it("fails on truncated and malformed child populations instead of declaring health", async () => {
    for (const response of [
      connection([child], true, null),
      connection([{ ...child, updatedAt: "bad" }]),
      connection([child, child]),
    ]) {
      const port = trackerFor(async (_query, vars) =>
        "parent" in (vars.filter as Record<string, unknown>)
          ? response
          : connection([epic]),
      );
      await expect(fetchEpicActivity(port, "epic")).rejects.toThrow();
    }
  });
});
