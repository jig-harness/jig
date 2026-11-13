/**
 * dispatch: the repository's query on a forge that runs out of time. A page
 * of pull requests the forge cannot answer in time is asked again at half
 * the size, the read keeps the size it ended at for the next one, and a
 * failure that is not the forge running out of time is not asked again.
 * The comments query over named pull requests shrinks the same way.
 */
import { describe, expect, it } from "bun:test";
import { failed, ok } from "../../shared/outcome.ts";
import { GROW_AFTER_MS, type KeptSize } from "../../shared/outbound/paging.ts";
import {
  type AskComments,
  type AskPage,
  PAGE,
  type PageSizes,
  ranOutOfTime,
  readComments,
  readRepository,
} from "../lib/forge-batch.ts";

const PATH = "/checkouts/example-repo";
const SLUG = "example-org/example-repo";

/** Page sizes kept in a map, and every size set. */
function kept(start: Record<string, unknown> = {}) {
  const held = new Map(Object.entries(start));
  const sets: Array<[string, KeptSize]> = [];
  const sizes: PageSizes = {
    get: (key) => held.get(key),
    set: (key, size) => {
      held.set(key, size);
      sets.push([key, size]);
    },
  };
  return { sizes, sets, held };
}

/**
 * A forge with `open` pull requests that runs out of time on a page of more
 * than `most`; `asked` is each page's size as it was asked.
 */
function forge(open: number, most: number) {
  const asked: number[] = [];
  const ask: AskPage = async (_path, after, size) => {
    asked.push(size);
    if (size > most)
      return failed("too-costly", "gh api graphql exited 1: gh: HTTP 504");
    const from = after === null ? 0 : Number(after);
    const nodes = Array.from(
      { length: Math.min(size, open - from) },
      (_, i) => ({
        number: from + i + 1,
        headRefName: `feature/${from + i + 1}`,
        labels: { pageInfo: { hasNextPage: false }, nodes: [] },
        comments: { pageInfo: { hasNextPage: false }, nodes: [] },
      }),
    );
    const next = from + nodes.length;
    return ok({
      data: {
        rateLimit: { cost: 1, remaining: 4990 },
        repository: {
          nameWithOwner: SLUG,
          defaultBranchRef: { name: "main", target: { file: null } },
          pullRequests: {
            pageInfo: { hasNextPage: next < open, endCursor: String(next) },
            nodes,
          },
        },
      },
    });
  };
  return { asked, ask };
}

describe("a repository whose pull requests the forge cannot answer a full page of", () => {
  it("is read whole in smaller pages", async () => {
    const { asked, ask } = forge(25, 10);
    const { sizes } = kept();
    const read = await readRepository(PATH, sizes, ask);
    if (!read.ok) throw new Error(read.failure.reason);
    expect(
      read.value.open.map((p) => (p as { number: number }).number),
    ).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    // The first page shrinks to a size the forge answers; the rest keep it.
    expect(asked).toEqual([50, 25, 12, 6, 6, 6, 6, 6]);
    expect(read.value.pageSize).toBe(6);
    expect(read.value.pages).toBe(5);
  });

  it("starts the next read from the size the last one kept", async () => {
    const { ask } = forge(25, 10);
    const { sizes, sets } = kept();
    await readRepository(PATH, sizes, ask);
    expect(sets.map(([key, size]) => [key, size.size])).toEqual([
      [`repository:${PATH}`, 6],
    ]);
    const again = forge(25, 10);
    const read = await readRepository(PATH, sizes, again.ask);
    expect(read.ok).toBe(true);
    expect(again.asked).toEqual([6, 6, 6, 6, 6]);
    // Its pages answered at once, but a page shrank within the hour: nothing new is kept.
    expect(sets).toHaveLength(1);
  });

  it("tries twice the kept size once an hour has passed since a page shrank", async () => {
    const { ask } = forge(25, 50);
    const shrankAt = Date.now() - GROW_AFTER_MS;
    const { sizes, sets } = kept({
      [`repository:${PATH}`]: { size: 6, shrankAt },
    });
    const read = await readRepository(PATH, sizes, ask);
    expect(read.ok).toBe(true);
    expect(sets).toEqual([[`repository:${PATH}`, { size: 12, shrankAt }]]);
  });

  it("keeps the size it shrank to when a later page fails for another reason", async () => {
    const { ask } = forge(25, 10);
    const { sizes, sets } = kept();
    let pages = 0;
    const read = await readRepository(
      PATH,
      sizes,
      async (path, after, size) => {
        const answer = await ask(path, after, size);
        if (answer.ok) pages += 1;
        return answer.ok && pages === 2
          ? failed("unreadable", "the query's answer is not JSON")
          : answer;
      },
    );
    expect(read.ok).toBe(false);
    expect(sets.map(([key, size]) => [key, size.size])).toEqual([
      [`repository:${PATH}`, 6],
    ]);
  });

  it("does not read when the forge runs out of time on one pull request, and says so", async () => {
    const { asked, ask } = forge(25, 0);
    const { sizes, sets } = kept();
    const read = await readRepository(PATH, sizes, ask);
    expect(asked).toEqual([50, 25, 12, 6, 3, 1]);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.code).toBe("unreadable");
    expect(read.failure.reason).toBe(
      "gh api graphql exited 1: gh: HTTP 504: the forge ran out of time on a page of pull requests, asked one at a time",
    );
    expect(sets.map(([key, size]) => [key, size.size])).toEqual([
      [`repository:${PATH}`, 1],
    ]);
  });

  it("is asked once, at the full page, when the failure is not the forge running out of time", async () => {
    const asked: number[] = [];
    const { sizes, sets } = kept();
    const read = await readRepository(PATH, sizes, async (_p, _after, size) => {
      asked.push(size);
      return failed("unreadable", "gh api graphql exited 1: gh: HTTP 502");
    });
    expect(asked).toEqual([PAGE]);
    expect(read.ok).toBe(false);
    expect(sets).toEqual([]);
  });

  it("keeps no size for a repository the forge answers a full page of", async () => {
    const { asked, ask } = forge(60, 50);
    const { sizes, sets } = kept();
    const read = await readRepository(PATH, sizes, ask);
    expect(read.ok).toBe(true);
    expect(asked).toEqual([50, 50]);
    expect(sets).toEqual([]);
  });

  it("starts at the full page when what was kept is not a page size", async () => {
    const { asked, ask } = forge(3, 50);
    const { sizes } = kept({ [`repository:${PATH}`]: "six" });
    await readRepository(PATH, sizes, ask);
    expect(asked).toEqual([PAGE]);
  });
});

describe("named pull requests' comments the forge cannot answer a full query of", () => {
  /** A forge that runs out of time on a comments query over more than `most` pull requests. */
  function commentsForge(most: number) {
    const asked: number[][] = [];
    const ask: AskComments = async (_owner, _name, prs) => {
      asked.push([...prs]);
      if (prs.length > most)
        return failed("too-costly", "gh api graphql exited 1: gh: HTTP 504");
      const repository: Record<string, unknown> = {};
      for (const n of prs)
        repository[`pr${n}`] = {
          comments: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
      return ok({ data: { rateLimit: { cost: 1 }, repository } });
    };
    return { asked, ask };
  }

  it("are read in smaller queries, every pull request once", async () => {
    const prs = Array.from({ length: 20 }, (_, i) => i + 1);
    const { asked, ask } = commentsForge(8);
    const { sizes, sets } = kept();
    const read = await readComments(SLUG, prs, sizes, ask);
    if (!read.ok) throw new Error(read.failure.reason);
    expect([...read.value.comments.keys()]).toEqual(prs);
    expect(asked.map((chunk) => chunk.length)).toEqual([20, 10, 5, 5, 5, 5]);
    expect(read.value.pages).toBe(4);
    expect(sets.map(([key, size]) => [key, size.size])).toEqual([
      [`comments:${SLUG}`, 5],
    ]);
  });

  it("starts a final short query at the number of pull requests remaining", async () => {
    const { asked, ask } = commentsForge(1);
    const read = await readComments(SLUG, [1, 2], undefined, ask);
    expect(read.ok).toBe(true);
    expect(asked.map((chunk) => chunk.length)).toEqual([2, 1, 1]);
  });

  it("keeps no size when a query is short only because fewer pull requests remain", async () => {
    const prs = Array.from({ length: 51 }, (_, i) => i + 1);
    const { asked, ask } = commentsForge(50);
    const { sizes, sets } = kept();
    const read = await readComments(SLUG, prs, sizes, ask);
    expect(read.ok).toBe(true);
    expect(asked.map((chunk) => chunk.length)).toEqual([50, 1]);
    expect(sets).toEqual([]);
  });

  it("keeps no size when no pull request is named", async () => {
    const { asked, ask } = commentsForge(8);
    const { sizes, sets } = kept({
      [`comments:${SLUG}`]: { size: 6, shrankAt: 0 },
    });
    const read = await readComments(SLUG, [], sizes, ask);
    expect(read.ok).toBe(true);
    expect(asked).toEqual([]);
    expect(sets).toEqual([]);
  });
});

describe("what says the forge ran out of time", () => {
  const answered = (stderr: string) => ({ timedOut: false, stderr });

  it("is a gateway timeout the forge took its time over", () => {
    expect(ranOutOfTime(answered("gh: HTTP 504"), 11_000)).toBe(true);
    expect(
      ranOutOfTime(
        answered("HTTP 502: 502 Bad Gateway (https://api.github.com/graphql)"),
        10_200,
      ),
    ).toBe(true);
  });

  it("is the call's own deadline", () => {
    expect(ranOutOfTime({ timedOut: true, stderr: "" }, 30_000)).toBe(true);
  });

  it("is not a gateway error the forge answered at once", () => {
    expect(ranOutOfTime(answered("gh: HTTP 502"), 300)).toBe(false);
  });

  it("is not another failure, however long it took", () => {
    expect(ranOutOfTime(answered("gh: Not Found (HTTP 404)"), 11_000)).toBe(
      false,
    );
    expect(ranOutOfTime(answered("gh: HTTP 5040"), 11_000)).toBe(false);
  });
});
