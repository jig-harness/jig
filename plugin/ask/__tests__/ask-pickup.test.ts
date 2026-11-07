/**
 * `jig ask pickup@…`: the item is read through the tracker interface the
 * checkout's configuration names (the GitHub adapter, over a fake GraphQL
 * endpoint), with its key checked against that tracker's form first; an item
 * assigned to the factory identity reads as assigned, an item the tracker
 * does not have exits 1, and a pick-up makes no forge call.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  issueNode,
  oneIssue,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import type { AskAnswer } from "../lib/answer.ts";
import { type AskWorld, askWorld, REPO } from "./ask-fixtures.ts";

let current: AskWorld | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
  current?.close();
  current = null;
});

function world(): AskWorld {
  const w = askWorld();
  current = w;
  mkdirSync(join(w.repo, ".config"), { recursive: true });
  writeFileSync(
    join(w.repo, ".config", "jig.yaml"),
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${REPO}\ndispatch:\n  identity: factory-bot\n`,
  );
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { query, variables } = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const op = /query\s+(\w+)/.exec(query)?.[1];
      // The factory identity's items: #12 waits, #13 is in progress.
      if (op === "TrackerIssues") {
        const sub = {
          subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
        };
        return Response.json({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  issueNode({
                    number: 12,
                    repo: REPO,
                    assignee: "factory-bot",
                    extra: sub,
                  }),
                  issueNode({
                    number: 13,
                    repo: REPO,
                    assignee: "factory-bot",
                    labels: ["In Progress"],
                    extra: sub,
                  }),
                ],
              },
            },
          },
        });
      }
      if (op !== "TrackerIssue")
        return Response.json({ errors: [{ message: `unhandled ${op}` }] });
      return Response.json({
        data: oneIssue(
          variables.number === 12 || variables.number === 13
            ? issueNode({
                number: variables.number,
                repo: REPO,
                assignee: "factory-bot",
                ...(variables.number === 13 ? { labels: ["In Progress"] } : {}),
                extra: {
                  subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
                },
              })
            : null,
        ),
      });
    },
  });
  w.env.JIG_GITHUB_GRAPHQL_URL = `http://127.0.0.1:${server.port}/graphql`;
  return w;
}

describe("jig ask pickup", () => {
  it("reads the item through the tracker and places its claim", async () => {
    const w = world();
    const r = await w.ask([`pickup@${REPO}#12`, "--json"]);
    expectSpawnExit(r, 0);
    const answer = JSON.parse(r.stdout) as AskAnswer;
    expect(answer.address).toBe(`pickup@${REPO}#12`);
    expect(answer.key).toBe("#12");
    expect(answer.state).toBe("assigned");
    expect(answer.holder).toBe("none");
    expect(answer.sources.trackerCalls).toBe(3);
    expect(answer.sources.forgeCalls).toBe(0);
    expect(w.calls()).toEqual([]);
  });

  it("reads an item in the dispatcher's in-progress state as claimed", async () => {
    const w = world();
    const r = await w.ask([`pickup@${REPO}#13`, "--json"]);
    expectSpawnExit(r, 0);
    expect((JSON.parse(r.stdout) as AskAnswer).state).toBe("claimed");
  });

  it("exits 1 for an item the tracker does not have, and 2 for a key not in its form", async () => {
    const w = world();
    const missing = await w.ask([`pickup@${REPO}#99`]);
    expectSpawnExit(missing, 1);
    expect(missing.stdout).toContain("no such item");
    const malformed = await w.ask([`pickup@${REPO}#ENG-4`]);
    expectSpawnExit(malformed, 2);
    expect(malformed.stderr).toContain("is not an item key");
  });
});
