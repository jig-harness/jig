/** Reading the pull request's review threads, and which of them are a person's. */
import { describe, expect, it } from "bun:test";
import {
  pageFrom,
  personThreadsOn,
  personsWords,
  refusalLines,
  type ReviewThread,
} from "../scripts/lib/person-threads.ts";

const comment = (
  type: string,
  association: string,
  body: string,
  login = type === "Bot" ? "review-bot" : "maintainer",
) => ({
  login,
  type,
  association,
  body,
  at: "2026-01-01T00:00:00Z",
  url: "https://example.invalid/c",
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
      "maintainer",
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
    expect(personsWords(t, "maintainer")).toEqual([]);
  });
});

describe("personsWords and the drive's login", () => {
  it("reads another login's outcome-prefixed reply as a person's verdict", () => {
    const t = thread({
      comments: [
        comment("Bot", "NONE", "Finding."),
        comment(
          "User",
          "MEMBER",
          "**rejected** — keep these configurable.",
          "other",
        ),
      ],
    });
    expect(personsWords(t, "maintainer").map((w) => w.login)).toEqual([
      "other",
    ]);
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

  it("counts only words posted after a ruling's time, and a time it cannot read as after", () => {
    const old = thread({
      id: "PRRT_old",
      comments: [comment("User", "OWNER", "Old.")],
    });
    const found = (since: string) =>
      personThreadsOn([old], "PRRT_self", "a.md", "maintainer", since);
    expect(found("2026-02-01T00:00:00Z").map((p) => p.fresh)).toEqual([false]);
    expect(found("2025-12-01T00:00:00Z").map((p) => p.fresh)).toEqual([true]);
    expect(found("not a time").map((p) => p.fresh)).toEqual([true]);
    expect(found("2026-02-01T00:00:00Z")[0]?.words).toHaveLength(1);
  });

  it("counts a comment edited after the watermark as new words", () => {
    const edited = thread({
      id: "PRRT_edit",
      comments: [
        {
          ...comment("User", "OWNER", "Do not change this."),
          editedAt: "2026-03-01T00:00:00Z",
        },
      ],
    });
    const found = (since: string) =>
      personThreadsOn([edited], "PRRT_self", "a.md", "maintainer", since);
    expect(found("2026-02-01T00:00:00Z")[0]?.fresh).toBe(true);
    expect(found("2026-04-01T00:00:00Z")[0]?.fresh).toBe(false);
  });

  it("lists the other threads on the file a person spoke on, and those it could not read whole", () => {
    const found = personThreadsOn(
      [mine, ruling, elsewhere, long, quiet],
      "PRRT_self",
      "a.md",
      "maintainer",
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
        viewer: { login: "maintainer" },
        node: {
          path: "a.md",
          pullRequest: { reviewThreads: { pageInfo, nodes } },
        },
      },
    });

  it("reads a last page, and a page that names its next cursor", () => {
    expect(pageFrom(page({ hasNextPage: false, endCursor: null }))).toEqual({
      path: "a.md",
      viewer: "maintainer",
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

  it("reads a null author as no person, and an author missing its login or type as unreadable", () => {
    const c = {
      url: "u",
      createdAt: "2026-01-01T00:00:00Z",
      lastEditedAt: null,
      authorAssociation: "OWNER",
      body: "b",
    };
    const read = (author: unknown) =>
      pageFrom(
        page({ hasNextPage: false }, [
          {
            id: "T",
            path: "a.md",
            isResolved: false,
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [{ ...c, author }],
            },
          },
        ]),
      );
    expect(read(null)?.threads[0]?.comments[0]?.type).toBe("");
    expect(read({ login: "maintainer" })).toBeNull();
    expect(read({ __typename: "User" })).toBeNull();
    expect(read({ login: "m", __typename: "User" })).not.toBeNull();
  });

  it("refuses an answer it cannot read whole", () => {
    expect(pageFrom("not json")).toBeNull();
    expect(pageFrom(JSON.stringify({ data: { node: null } }))).toBeNull();
    expect(pageFrom(page({ hasNextPage: true, endCursor: "" }))).toBeNull();
    expect(pageFrom(page({}))).toBeNull();
    expect(pageFrom(page({ hasNextPage: false }, [{ id: "T" }]))).toBeNull();
    const whole = {
      id: "T",
      path: "a.md",
      isResolved: false,
      comments: { pageInfo: { hasNextPage: false }, nodes: [null] },
    };
    expect(pageFrom(page({ hasNextPage: false }, [whole]))).toBeNull();
    expect(
      pageFrom(
        page({ hasNextPage: false }, [
          { ...whole, comments: { nodes: [] }, path: null },
        ]),
      ),
    ).toBeNull();
    expect(
      pageFrom(JSON.stringify({ data: { node: { pullRequest: {} } } })),
    ).toBeNull();
  });
});

describe("refusalLines", () => {
  it("names each thread's state, place and a person's words, then what to do next", () => {
    const lines = refusalLines("PRRT_bot", "a.md", [
      {
        id: "PRRT_p",
        url: "https://example.invalid/p",
        line: 3,
        isResolved: true,
        truncated: false,
        fresh: true,
        words: [
          comment(
            "User",
            "OWNER",
            `Keep\nit. ${"x".repeat(400)} Never disable it.`,
          ),
        ],
      },
      {
        id: "PRRT_q",
        url: "",
        line: null,
        isResolved: false,
        truncated: true,
        fresh: true,
        words: [],
      },
    ]);
    expect(lines[1]).toContain(
      "resolved thread PRRT_p (https://example.invalid/p) at a.md:3: maintainer:",
    );
    expect(lines[1]).toEndWith('Never disable it."');
    expect(lines[2]).toBe(
      "  - open thread PRRT_q at a.md: more than 100 comments, read it on the pull request",
    );
    expect(lines.join("\n")).toContain("review arbiter");
  });
});
