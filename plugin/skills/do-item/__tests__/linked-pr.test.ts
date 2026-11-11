/**
 * Whether an item's linked pull request merged: how its pull requests are
 * found (the links in its comments, the issue-link line in a pull request's
 * body) and how they reduce to one reading, failing closed.
 */

import { describe, expect, it } from "bun:test";
import {
  linkedPrState,
  linksIssue,
  hasPullAssociation,
  type LinkedPrReads,
  type PullFact,
  pullNumbersIn,
  linkLineKey,
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

describe("hasPullAssociation", () => {
  it("ignores a marker inside a multiline inline-code example", () => {
    const marker = `<!-- do-item-pr: https://github.com/${REPO}/pull/9 -->`;
    expect(
      hasPullAssociation(`Example: \`first\n${marker}\nlast\``, REPO, 9),
    ).toBe(false);
    expect(hasPullAssociation(marker, REPO, 9)).toBe(true);
  });

  it("recognizes only the explicit association marker for that pull request", () => {
    expect(
      hasPullAssociation(
        `<!-- do-item-pr: https://github.com/${REPO}/pull/12 -->`,
        REPO,
        12,
      ),
    ).toBe(true);
    expect(
      hasPullAssociation(
        `<!-- do-item-pr: https://github.com/${REPO}/pull/13 -->`,
        REPO,
        12,
      ),
    ).toBe(false);
  });

  it("accepts repository casing GitHub treats as equivalent", () => {
    expect(
      hasPullAssociation(
        "<!-- do-item-pr: https://github.com/EXAMPLE-ORG/EXAMPLE-REPO/pull/12 -->",
        REPO,
        12,
      ),
    ).toBe(true);
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

  it("does not read issue links from quoted or fenced examples", () => {
    expect(linksIssue("```text\nCloses ENG-123\n```", "ENG-123", team)).toBe(
      false,
    );
    expect(linksIssue("> Closes ENG-123", "ENG-123", team)).toBe(false);
  });

  it("masks inline-code spans without joining text across them or across lines", () => {
    expect(linksIssue("`example`Closes ENG-5", "ENG-5", team)).toBe(false);
    expect(
      linksIssue("Example: `first\nCloses ENG-5\nlast`", "ENG-5", team),
    ).toBe(false);
    expect(linksIssue("Closes ENG-`1`5", "ENG-15", team)).toBe(false);
    expect(linksIssue("`unclosed\nCloses ENG-5", "ENG-5", team)).toBe(true);
    expect(linksIssue("a \\`\nCloses ENG-5\nb \\`", "ENG-5", team)).toBe(true);
    const table = [
      "| A | B |",
      "| - | - |",
      "| Refs ENG-1 | ` |",
      "| Refs ENG-5 | ` |",
    ];
    expect(linksIssue(table.join("\n"), "ENG-5", team)).toBe(true);
    for (const marker of ["-", "1.", "- -"]) {
      const listed = [
        `${marker} | A | B |`,
        "  | - | - |",
        "  | Refs ENG-1 | ` |",
        "  | Refs ENG-5 | ` |",
      ];
      expect(linksIssue(listed.join("\n"), "ENG-5", team)).toBe(true);
    }
    const bareDelimiter = "- | - | - |";
    expect(
      linksIssue(`| \`x | Closes ENG-5\` |\n${bareDelimiter}`, "ENG-5", team),
    ).toBe(false);
    expect(
      linksIssue(`| \` | Refs ENG-5 | \` |\n${bareDelimiter}`, "ENG-5", team),
    ).toBe(true);
    const bad = "| A | B |\n| - |\nEg: `x\nCloses ENG-5\ny`";
    expect(linksIssue(bad, "ENG-5", team)).toBe(false);
    expect(linksIssue("`a`\n\nCloses ENG-5", "ENG-5", team)).toBe(true);
  });

  it("reads every eligible table cell but not inline-code examples", () => {
    expect(linksIssue("| Refs ENG-1 | Refs ENG-5 |", "ENG-5", team)).toBe(true);
    expect(linksIssue("Example: `| Closes ENG-5 |`", "ENG-5", team)).toBe(
      false,
    );
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
          return { ...pull(n, "OPEN"), body: "Closes ENG-5" };
        },
      }),
    );
    expect(viewed).toEqual([4]);
    expect(r.pullRequest).toBe("open");
  });

  it("ignores a pull request a comment mentions whose body does not link the item", async () => {
    const r = await read(
      reads({
        comments: async () => [`Related: https://github.com/${REPO}/pull/12`],
        view: async (n) => ({ ...pull(n, "MERGED"), body: "Unrelated" }),
      }),
    );
    expect(r.pullRequest).toBe("none");
  });

  it("matches a qualified issue-link line when the tracker is another repository", async () => {
    const readFor = (body: string) =>
      readLinkedPr("#5", {
        reads: reads({
          search: async () => [{ ...pull(9, "MERGED"), body }],
        }),
        repository: REPO,
        keySource: "#[1-9]\\d*",
        trunk: TRUNK,
        trackerRepository: "example-org/tracker",
      });
    expect((await readFor("Closes example-org/tracker#5")).pullRequest).toBe(
      "merged",
    );
    expect((await readFor("Closes #5")).pullRequest).toBe("none");
    expect((await readFor("Refs example-org/tracker#5abc")).pullRequest).toBe(
      "none",
    );
  });

  it("accepts an explicitly associated comment-linked pull request when no link line is required", async () => {
    const readFor = (body: string) =>
      readLinkedPr("ENG-1", {
        reads: reads({
          comments: async () => [
            {
              body: `<!-- do-item-pr: https://github.com/${REPO}/pull/9 -->\nhttps://github.com/${REPO}/pull/9`,
              trusted: true,
            },
          ],
          view: async () => ({ ...pull(9, "MERGED"), body }),
        }),
        repository: REPO,
        keySource: "ENG-\\d+(?!\\w)",
        trunk: TRUNK,
        bodyLinkRequired: false,
      });
    expect(
      (await readFor("Implement the requested validation")).pullRequest,
    ).toBe("merged");
  });

  it("rejects a comment-linked pull request whose generic body mentions the item", async () => {
    const r = await readLinkedPr("ENG-1", {
      reads: reads({
        comments: async () => [`https://github.com/${REPO}/pull/9`],
        view: async () => ({
          ...pull(9, "MERGED"),
          body: "Remaining validation is deferred to ENG-1",
        }),
      }),
      repository: REPO,
      keySource: "ENG-\\d+(?!\\w)",
      trunk: TRUNK,
      bodyLinkRequired: false,
    });
    expect(r.pullRequest).toBe("none");
  });

  it("requires a trusted author for an explicit association marker", async () => {
    const r = await readLinkedPr("ENG-1", {
      reads: reads({
        comments: async () => [
          {
            body: `<!-- do-item-pr: https://github.com/${REPO}/pull/9 -->`,
            trusted: false,
          },
        ],
        view: async () => ({ ...pull(9, "MERGED"), body: "Unrelated" }),
      }),
      repository: REPO,
      keySource: "ENG-\\d+(?!\\w)",
      trunk: TRUNK,
      bodyLinkRequired: false,
    });
    expect(r.pullRequest).toBe("none");
  });

  it("ignores unassociated comment links before reading their pull requests", async () => {
    const viewed: number[] = [];
    const r = await readLinkedPr("ENG-1", {
      reads: reads({
        comments: async () => [
          {
            body: `https://github.com/${REPO}/pull/999`,
            trusted: false,
          },
        ],
        view: async (number) => {
          viewed.push(number);
          return null;
        },
      }),
      repository: REPO,
      keySource: "ENG-\\d+(?!\\w)",
      trunk: TRUNK,
      bodyLinkRequired: false,
    });
    expect(viewed).toEqual([]);
    expect(r.pullRequest).toBe("none");
  });

  it("does not accept association markers in fenced examples", async () => {
    const r = await readLinkedPr("ENG-1", {
      reads: reads({
        comments: async () => [
          {
            body: `\`\`\`html\n<!-- do-item-pr: https://github.com/${REPO}/pull/9 -->\n\`\`\``,
            trusted: true,
          },
        ],
        view: async () => ({ ...pull(9, "MERGED"), body: "Unrelated" }),
      }),
      repository: REPO,
      keySource: "ENG-\\d+(?!\\w)",
      trunk: TRUNK,
      bodyLinkRequired: false,
    });
    expect(r.pullRequest).toBe("none");
  });

  it("matches a same-repository qualified issue-link line beside the bare one", async () => {
    const readFor = (body: string) =>
      readLinkedPr("#5", {
        reads: reads({
          search: async () => [{ ...pull(9, "MERGED"), body }],
        }),
        repository: REPO,
        keySource: "#[1-9]\\d*(?!\\w)",
        trunk: TRUNK,
        trackerRepository: REPO,
      });
    expect((await readFor(`Refs ${REPO}#5`)).pullRequest).toBe("merged");
    expect((await readFor("Closes #5")).pullRequest).toBe("merged");
    expect((await readFor(`Closes ${REPO}#50`)).pullRequest).toBe("none");
    expect((await readFor("Closes other-org/x#5")).pullRequest).toBe("none");
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

describe("linkLineKey", () => {
  it("qualifies a bare number only when the tracker is another repository", () => {
    expect(linkLineKey("#5", "example-org/tracker", REPO)).toBe(
      "example-org/tracker#5",
    );
    expect(linkLineKey("#5", REPO, REPO)).toBe("#5");
    expect(linkLineKey("#5", undefined, REPO)).toBe("#5");
    expect(linkLineKey("ENG-1", "example-org/tracker", REPO)).toBe("ENG-1");
  });
});
