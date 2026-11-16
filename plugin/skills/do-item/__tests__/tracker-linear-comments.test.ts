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
