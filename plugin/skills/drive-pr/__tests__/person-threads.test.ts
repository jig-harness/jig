/** Reading the pull request's review threads, and which of them are a person's. */
import { describe, expect, it } from "bun:test";
import {
  pageFrom,
  personThreadsOn,
  personsWords,
  refusalLines,
  type ReviewThread,
} from "../scripts/lib/person-threads.ts";

const comment = (type: string, association: string, body: string) => ({
  login: type === "Bot" ? "review-bot" : "maintainer",
  type,
  association,
  body,
});

function thread(over: Partial<ReviewThread>): ReviewThread {
  return {
    id: "PRRT_x",
    path: "a.md",
    line: 3,
    isResolved: true,
    truncated: false,
    comments: [],
    ...over,
  };
}

describe("personsWords", () => {
  it("keeps a person's opening comment and later words, not the drive's outcome replies or markers", () => {
    const words = personsWords(
      thread({
        comments: [
          comment("User", "OWNER", "**accepted** is what I want here."),
          comment("User", "OWNER", "**accepted** — done in abc1234."),
          comment("User", "MEMBER", "Keep the old name."),
          comment("User", "OWNER", "status <!-- drive-marker -->"),
          comment("User", "NONE", "An outsider's view."),
          comment("Bot", "OWNER", "A bot's note."),
        ],
      }),
    );
    expect(words.map((w) => w.body)).toEqual([
      "**accepted** is what I want here.",
      "Keep the old name.",
    ]);
  });

  it("finds no person in a bot's thread the drive answered", () => {
    const t = thread({
      comments: [
        comment("Bot", "NONE", "Finding."),
        comment("User", "OWNER", "**rejected** — intended."),
      ],
    });
    expect(personsWords(t)).toEqual([]);
  });
});

describe("personThreadsOn", () => {
  const mine = thread({
    id: "PRRT_self",
    comments: [comment("User", "OWNER", "Do it.")],
  });
  const ruling = thread({
    id: "PRRT_rule",
    comments: [comment("User", "OWNER", "Ruling.")],
  });
  const elsewhere = { ...ruling, id: "PRRT_else", path: "b.md" };
  const long = thread({
    id: "PRRT_long",
    truncated: true,
    comments: [comment("Bot", "NONE", "x")],
  });
  const quiet = thread({
    id: "PRRT_quiet",
    comments: [comment("Bot", "NONE", "x")],
  });

  it("lists the other threads on the file a person spoke on, and those it could not read whole", () => {
    const found = personThreadsOn(
      [mine, ruling, elsewhere, long, quiet],
      "PRRT_self",
      "a.md",
    );
    expect(found.map((p) => [p.truncated, p.words.map((w) => w.body)])).toEqual(
      [
        [false, ["Ruling."]],
        [true, []],
      ],
    );
  });
});

describe("pageFrom", () => {
  const page = (pageInfo: unknown, nodes: unknown[] = []) =>
    JSON.stringify({
      data: {
        node: {
          path: "a.md",
          pullRequest: { reviewThreads: { pageInfo, nodes } },
        },
      },
    });

  it("reads a last page, and a page that names its next cursor", () => {
    expect(pageFrom(page({ hasNextPage: false, endCursor: null }))).toEqual({
      path: "a.md",
      threads: [],
      endCursor: null,
    });
    expect(
      pageFrom(page({ hasNextPage: true, endCursor: "c2" }))?.endCursor,
    ).toBe("c2");
  });

  it("reads a thread whose comment window does not say it is complete as truncated", () => {
    const t = {
      id: "T",
      path: "a.md",
      line: 1,
      isResolved: false,
      comments: { nodes: [] },
    };
    expect(
      pageFrom(page({ hasNextPage: false }, [t]))?.threads[0]?.truncated,
    ).toBe(true);
  });

  it("refuses an answer it cannot read whole", () => {
    expect(pageFrom("not json")).toBeNull();
    expect(pageFrom(JSON.stringify({ data: { node: null } }))).toBeNull();
    expect(pageFrom(page({ hasNextPage: true, endCursor: "" }))).toBeNull();
    expect(pageFrom(page({}))).toBeNull();
    expect(pageFrom(page({ hasNextPage: false }, [{ id: "T" }]))).toBeNull();
  });
});

describe("refusalLines", () => {
  it("names each thread's state, place and a person's words, then what to do next", () => {
    const lines = refusalLines("PRRT_bot", "a.md", [
      {
        line: 3,
        isResolved: true,
        truncated: false,
        words: [comment("User", "OWNER", "Keep\nit.")],
      },
      { line: null, isResolved: false, truncated: true, words: [] },
    ]);
    expect(lines[1]).toBe(
      '  - resolved thread at a.md:3: maintainer: "Keep it."',
    );
    expect(lines[2]).toBe(
      "  - open thread at a.md: more than 100 comments, read it on the pull request",
    );
    expect(lines.join("\n")).toContain("review arbiter");
  });
});
