/**
 * The Linear adapter's comment facts name each comment's author, its link
 * and its last edit, read in the same request as its body and trust, so a
 * reader of a person's answer on an item needs no second request.
 */
import { describe, expect, it } from "bun:test";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";

const STATES = parseTrackerConfig({}).states;

function tracker(nodes: unknown[]) {
  const queries: string[] = [];
  const transport: LinearTransport = async (query) => {
    queries.push(query);
    return {
      issue: {
        id: "uuid-1",
        comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
      },
    };
  };
  return {
    t: linearTracker({ team: "ENG", states: STATES, transport }),
    queries,
  };
}

describe("Linear adapter: comment authors", () => {
  it("lists each comment with its author and what Linear vouches for about them", async () => {
    const { t } = tracker([
      {
        id: "c1",
        body: "a",
        createdAt: "2026-01-01T00:00:00Z",
        user: { id: "u1", name: "Dana", guest: false },
      },
      {
        id: "c2",
        body: "b",
        createdAt: "2026-01-02T00:00:00Z",
        user: { id: "u2", name: "Visitor", guest: true },
      },
      { id: "c3", body: "c", createdAt: "2026-01-03T00:00:00Z", user: null },
    ]);
    expect(await t.listComments("ENG-1")).toEqual([
      {
        body: "a",
        createdAt: "2026-01-01T00:00:00Z",
        author: "Dana",
        authorAssociation: "MEMBER",
      },
      {
        body: "b",
        createdAt: "2026-01-02T00:00:00Z",
        author: "Visitor",
        authorAssociation: "GUEST",
      },
      {
        body: "c",
        createdAt: "2026-01-03T00:00:00Z",
        authorAssociation: "UNKNOWN",
      },
    ]);
  });

  it("keeps a malformed edit time as written so the answer reader rejects the comment", async () => {
    const { t } = tracker([
      {
        id: "c1",
        body: "answer pickup: approve",
        createdAt: "2026-09-02T00:00:00.000Z",
        editedAt: "not-a-time",
        user: { id: "u-dana", name: "Dana Lee", guest: false },
      },
    ]);
    const { comments } = await t.issueComments("ENG-1");
    expect(comments[0]?.editedAt).toBe("not-a-time");
  });

  it("names each comment's author, its link and its last edit, in one request", async () => {
    const { t, queries } = tracker([
      {
        id: "c2",
        url: "https://linear.app/acme/issue/ENG-1/x#comment-c2",
        body: "answer pickup: approve",
        createdAt: "2026-09-02T00:00:00.000Z",
        editedAt: "2026-09-02T01:00:00.000Z",
        user: { id: "u-dana", name: "Dana Lee", guest: false },
      },
      {
        id: "c1",
        url: "https://linear.app/acme/issue/ENG-1/x#comment-c1",
        body: "from an integration",
        createdAt: "2026-09-01T00:00:00.000Z",
        editedAt: null,
        user: null,
      },
    ]);
    expect(t.commentAuthors).toBe(true);
    const { comments } = await t.issueComments("ENG-1");
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("user { id name guest }");
    expect(
      comments.map((c) => ({
        id: c.id,
        author: c.author,
        url: c.url,
        editedAt: c.editedAt,
        trusted: c.trusted,
      })),
    ).toEqual([
      {
        id: "c1",
        author: null,
        url: "https://linear.app/acme/issue/ENG-1/x#comment-c1",
        editedAt: null,
        trusted: false,
      },
      {
        id: "c2",
        author: { id: "u-dana", name: "Dana Lee" },
        url: "https://linear.app/acme/issue/ENG-1/x#comment-c2",
        editedAt: "2026-09-02T01:00:00.000Z",
        trusted: true,
      },
    ]);
  });
});
