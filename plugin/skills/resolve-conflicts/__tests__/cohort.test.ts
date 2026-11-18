/**
 * The merged-pull-request cohort the conflict rates count: one listing of
 * the window, newest update first, stopped at the first pull request updated
 * before what it needs, bounded in count, and kept by pull request and merge
 * commit so the next listing reaches back only to the one before it.
 */
import { describe, expect, it } from "bun:test";
import { failed, ok, type Outcome } from "../../../shared/outcome.ts";
import { isoFromMs, parseMs } from "../../../shared/time.ts";
import {
  type AskCohortPage,
  COHORT_LIMIT,
  type CohortCache,
  parseCohortCache,
  readCohort,
  RELIST_MARGIN_MS,
} from "../scripts/lib/cohort.ts";

const DAY = 86_400_000;
const NOW = parseMs("2026-11-18T12:00:00Z");
const SINCE = NOW - 30 * DAY;
const at = (ms: number) => isoFromMs(ms);

interface NodeOptions {
  merged: number;
  updated?: number;
  mergeCommit?: string;
  files?: string[];
  filesCut?: boolean;
  forcePushed?: boolean;
}

function node(n: number, o: NodeOptions): Record<string, unknown> {
  return {
    number: n,
    createdAt: at(o.merged - DAY),
    updatedAt: at(o.updated ?? o.merged),
    mergedAt: at(o.merged),
    headRefOid: String(n).padStart(40, "a"),
    baseRefName: "main",
    mergeCommit: { oid: o.mergeCommit ?? String(n).padStart(40, "c") },
    files: {
      pageInfo: { hasNextPage: o.filesCut === true },
      nodes: (o.files ?? [`src/${n}.ts`]).map((path) => ({ path })),
    },
    commits: {
      totalCount: 1,
      nodes: [
        {
          commit: {
            messageHeadline: `change ${n}`,
            authoredDate: at(o.merged - DAY),
            committedDate: at(o.merged - DAY),
          },
        },
      ],
    },
    timelineItems: {
      nodes: o.forcePushed ? [{ __typename: "HeadRefForcePushedEvent" }] : [],
    },
  };
}

/** A forge that answers the listing from `nodes`, `size` at a time, and records each page asked. */
function forge(
  nodes: Record<string, unknown>[],
  options: {
    fail?: (
      page: number,
      size: number,
    ) => Outcome<never, "unreadable" | "too-costly"> | null;
    repository?: string;
  } = {},
): { ask: AskCohortPage; asked: { after: string | null; size: number }[] } {
  const asked: { after: string | null; size: number }[] = [];
  const ask: AskCohortPage = async (after, size) => {
    asked.push({ after, size });
    const failure = options.fail?.(asked.length, size) ?? null;
    if (failure !== null) return failure;
    const start = after === null ? 0 : Number(after);
    const page = nodes.slice(start, start + size);
    const end = start + page.length;
    return ok({
      data: {
        rateLimit: { cost: 1, remaining: 4999 },
        repository: {
          nameWithOwner: options.repository ?? "acme/widgets",
          defaultBranchRef: { name: "main" },
          pullRequests: {
            pageInfo: {
              hasNextPage: end < nodes.length,
              endCursor: String(end),
            },
            nodes: page,
          },
        },
      },
    });
  };
  return { ask, asked };
}

describe("the merged-pull-request cohort", () => {
  it("lists the window, stops at the first pull request updated before it, and keeps only merges inside it", async () => {
    const nodes = [
      node(3, { merged: NOW - 1 * DAY }),
      node(2, { merged: NOW - 2 * DAY, files: ["a.ts", "b.ts"] }),
      // Merged before the window, updated inside it: listed, not counted.
      node(9, { merged: SINCE - 5 * DAY, updated: NOW - 3 * DAY }),
      node(1, { merged: NOW - 10 * DAY }),
      node(0, { merged: SINCE - 2 * DAY }),
      node(-1, { merged: SINCE - 3 * DAY }),
    ];
    const { ask, asked } = forge(nodes);
    const read = await readCohort({
      since: SINCE,
      until: null,
      now: NOW,
      cache: null,
      ask,
      pageSize: 2,
    });
    if (!read.ok) throw new Error(read.failure.reason);
    const cohort = read.value;
    expect(cohort.repository).toBe("acme/widgets");
    expect(cohort.defaultBranch).toBe("main");
    expect(cohort.prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(cohort.prs[1]?.files).toEqual(["a.ts", "b.ts"]);
    // The third page holds the first pull request updated before the window: no fourth is asked.
    expect(asked.map((a) => a.after)).toEqual([null, "2", "4"]);
    expect(cohort.listing).toMatchObject({
      pages: 3,
      listed: 4,
      reused: 0,
      cost: 3,
      from: "window",
    });
    expect(cohort.cache.listedAt).toBe(at(NOW));
    expect(cohort.cache.since).toBe(at(SINCE));
  });

  it("reads a pull request's force-push and a file list cut at its page", async () => {
    const { ask } = forge([
      node(4, { merged: NOW - DAY, forcePushed: true, filesCut: true }),
    ]);
    const read = await readCohort({
      since: SINCE,
      until: null,
      now: NOW,
      cache: null,
      ask,
    });
    if (!read.ok) throw new Error(read.failure.reason);
    expect(read.value.prs[0]).toMatchObject({
      number: 4,
      forcePushed: true,
      filesCut: true,
      commitCount: 1,
      commits: [{ subject: "change 4" }],
    });
  });

  it("is cut when the listing reaches its bound before the window ends, and says so", async () => {
    const nodes = Array.from({ length: 6 }, (_, i) =>
      node(100 - i, { merged: NOW - (i + 1) * 3_600_000 }),
    );
    const { ask } = forge(nodes);
    const read = await readCohort({
      since: SINCE,
      until: null,
      now: NOW,
      cache: null,
      ask,
      pageSize: 2,
      limit: 4,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.code).toBe("cut");
    expect(read.failure.reason).toContain("4");
  });

  it("bounds the listing at the forge's own count by default", () => {
    expect(COHORT_LIMIT).toBe(1000);
  });

  it("does not read when a page does not", async () => {
    const { ask } = forge(
      [node(1, { merged: NOW - DAY }), node(2, { merged: NOW - DAY })],
      {
        fail: (page) =>
          page === 2
            ? failed("unreadable", "gh api graphql exited 1: HTTP 401")
            : null,
      },
    );
    const read = await readCohort({
      since: SINCE,
      until: null,
      now: NOW,
      cache: null,
      ask,
      pageSize: 1,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.code).toBe("unreadable");
    expect(read.failure.reason).toContain("HTTP 401");
  });

  it("does not read when a pull request of a page does not", async () => {
    const broken = { ...node(1, { merged: NOW - DAY }), mergedAt: 7 };
    const { ask } = forge([broken]);
    const read = await readCohort({
      since: SINCE,
      until: null,
      now: NOW,
      cache: null,
      ask,
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.code).toBe("unreadable");
  });

  it("asks a page the forge ran out of time on again at half the size", async () => {
    const nodes = [1, 2, 3, 4].map((n) => node(n, { merged: NOW - n * DAY }));
    const { ask, asked } = forge(nodes, {
      fail: (_, size) => (size > 2 ? failed("too-costly", "HTTP 502") : null),
    });
    const read = await readCohort({
      since: SINCE,
      until: null,
      now: NOW,
      cache: null,
      ask,
      pageSize: 4,
    });
    if (!read.ok) throw new Error(read.failure.reason);
    expect(read.value.prs).toHaveLength(4);
    expect(asked[0]?.size).toBe(4);
    expect(asked[1]?.size).toBe(2);
  });

  it("reuses the previous listing: it reaches back only to that listing, and keeps what it held by pull request and merge commit", async () => {
    const listedAt = NOW - DAY;
    const first = forge([
      node(2, { merged: NOW - 2 * DAY }),
      node(1, { merged: NOW - 20 * DAY, mergeCommit: "1".repeat(40) }),
    ]);
    const earlier = await readCohort({
      since: SINCE - DAY,
      until: null,
      now: listedAt,
      cache: null,
      ask: first.ask,
    });
    if (!earlier.ok) throw new Error(earlier.failure.reason);
    const cache = JSON.parse(JSON.stringify(earlier.value.cache)) as unknown;

    const nodes = [
      node(5, { merged: NOW - 3_600_000 }),
      // Merged inside the window, updated since the previous listing: its new merge commit replaces the kept one.
      node(1, {
        merged: NOW - 20 * DAY,
        updated: NOW - 2 * 3_600_000,
        mergeCommit: "f".repeat(40),
      }),
      // Updated before the previous listing, less its margin: the listing stops here.
      node(2, {
        merged: NOW - 2 * DAY,
        updated: listedAt - RELIST_MARGIN_MS - 1,
      }),
      node(7, { merged: NOW - 25 * DAY }),
    ];
    const second = forge(nodes);
    const read = await readCohort({
      since: SINCE,
      until: null,
      now: NOW,
      cache,
      ask: second.ask,
      pageSize: 3,
    });
    if (!read.ok) throw new Error(read.failure.reason);
    expect(second.asked).toHaveLength(1);
    expect(read.value.prs.map((p) => [p.number, p.mergeCommit])).toEqual([
      [1, "f".repeat(40)],
      [2, String(2).padStart(40, "c")],
      [5, String(5).padStart(40, "c")],
    ]);
    expect(read.value.listing).toMatchObject({
      from: "previous listing",
      reused: 1,
    });
  });

  it("does not reuse a listing of another repository or of a shorter window", async () => {
    const make = (repository: string, since: number): CohortCache => ({
      schema: "merged-pr-cohort/v1",
      repository,
      since: at(since),
      listedAt: at(NOW - DAY),
      prs: [],
    });
    const nodes = [
      node(2, { merged: NOW - 2 * DAY, updated: NOW - 3 * DAY }),
      node(1, { merged: NOW - 20 * DAY }),
    ];
    for (const cache of [
      make("acme/other", SINCE),
      make("acme/widgets", SINCE + DAY),
    ]) {
      const { ask } = forge(nodes);
      const read = await readCohort({
        since: SINCE,
        until: null,
        now: NOW,
        cache,
        ask,
      });
      if (!read.ok) throw new Error(read.failure.reason);
      expect(read.value.listing.from).toBe("window");
      expect(read.value.prs.map((p) => p.number)).toEqual([1, 2]);
    }
  });

  it("refuses a kept listing that does not read", () => {
    expect(parseCohortCache({ schema: "merged-pr-cohort/v1" })).toBeNull();
    expect(parseCohortCache("nonsense")).toBeNull();
  });
});
