/**
 * Whether an item's linked pull request merged: how its pull requests are
 * found (the links in its comments, the issue-link line in a pull request's
 * body) and how they reduce to one reading, failing closed.
 */

import { describe, expect, it } from "bun:test";
import {
  linkedPrState,
  linksIssue,
  type LinkedPrReads,
  type PullFact,
  pullNumbersIn,
  readLinkedPr,
} from "../scripts/lib/linked-pr.ts";
import { numberKeys, teamKeys } from "../scripts/lib/tracker/keys.ts";

const REPO = "example-org/example-repo";
const TRUNK = "main";

function pull(
  number: number,
  state: string,
  baseRefName = TRUNK,
): PullFact & { body: string } {
  return {
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    state,
    baseRefName,
    body: "",
  };
}

describe("pullNumbersIn", () => {
  it("reads the repository's pull request links, and no other repository's", () => {
    const text = [
      `Pull request: https://github.com/${REPO}/pull/12`,
      "https://github.com/another-org/other/pull/13",
      `https://github.com/${REPO}/issues/14`,
      `and https://github.com/${REPO}/pull/15#discussion`,
    ].join("\n");
    expect(pullNumbersIn(text, REPO)).toEqual([12, 15]);
  });
});

describe("linksIssue", () => {
  const team = teamKeys("ENG").source;
  const numbers = numberKeys(REPO).source;

  it("reads a Closes or Refs line, in any case", () => {
    expect(linksIssue("Some text\n\nCloses ENG-123\n", "ENG-123", team)).toBe(
      true,
    );
    expect(linksIssue("refs ENG-123", "ENG-123", team)).toBe(true);
  });

  it("reads a batch's table cell", () => {
    expect(linksIssue("| Closes ENG-7 | `abc1234` | x |", "ENG-7", team)).toBe(
      true,
    );
  });

  it("does not read a longer key, or a key named in passing", () => {
    expect(linksIssue("Closes ENG-1234", "ENG-123", team)).toBe(false);
    expect(linksIssue("This follows up ENG-123.", "ENG-123", team)).toBe(false);
  });

  it("reads a GitHub number key", () => {
    expect(linksIssue("Closes #770", "#770", numbers)).toBe(true);
    expect(linksIssue("Closes #7701", "#770", numbers)).toBe(false);
  });
});

describe("linkedPrState", () => {
  it("reads a pull request merged into the integration branch as merged", () => {
    expect(linkedPrState([pull(1, "MERGED")], TRUNK)).toBe("merged");
  });

  it("reads an open pull request as open, even beside a merged one", () => {
    expect(linkedPrState([pull(1, "MERGED"), pull(2, "OPEN")], TRUNK)).toBe(
      "open",
    );
  });

  it("reads a pull request merged into another branch as not landed", () => {
    expect(linkedPrState([pull(1, "MERGED", "feature-base")], TRUNK)).toBe(
      "open",
    );
  });

  it("reads no pull request, or only closed ones, as none", () => {
    expect(linkedPrState([], TRUNK)).toBe("none");
    expect(linkedPrState([pull(1, "CLOSED")], TRUNK)).toBe("none");
  });
});

describe("readLinkedPr", () => {
  const keySource = teamKeys("ENG").source;

  function reads(over: Partial<LinkedPrReads> = {}): LinkedPrReads {
    return {
      comments: async () => [],
      search: async () => [],
      view: async () => null,
      ...over,
    };
  }
  const read = (r: LinkedPrReads) =>
    readLinkedPr("ENG-5", {
      reads: r,
      repository: REPO,
      keySource,
      trunk: TRUNK,
    });

  it("finds a merged pull request through its issue-link line", async () => {
    const r = await read(
      reads({
        search: async () => [
          { ...pull(9, "MERGED"), body: "Closes ENG-5" },
          { ...pull(10, "OPEN"), body: "Mentions ENG-5 only" },
        ],
      }),
    );
    expect(r).toMatchObject({
      pullRequest: "merged",
      pulls: [`https://github.com/${REPO}/pull/9`],
    });
  });

  it("finds an open pull request through the item's link comment", async () => {
    const viewed: number[] = [];
    const r = await read(
      reads({
        comments: async () => [`Opened https://github.com/${REPO}/pull/4`],
        view: async (n) => {
          viewed.push(n);
          return pull(n, "OPEN");
        },
      }),
    );
    expect(viewed).toEqual([4]);
    expect(r.pullRequest).toBe("open");
  });

  it("reads an item with no linked pull request as none", async () => {
    const r = await read(reads());
    expect(r).toMatchObject({ pullRequest: "none", pulls: [] });
    expect(r.reason).toBe("ENG-5 has no linked pull request");
  });

  it("fails closed when any read fails", async () => {
    expect(
      (await read(reads({ comments: async () => null }))).pullRequest,
    ).toBe("unreadable");
    expect((await read(reads({ search: async () => null }))).pullRequest).toBe(
      "unreadable",
    );
    expect(
      (
        await read(
          reads({
            comments: async () => [`https://github.com/${REPO}/pull/3`],
            view: async () => null,
          }),
        )
      ).pullRequest,
    ).toBe("unreadable");
  });
});
