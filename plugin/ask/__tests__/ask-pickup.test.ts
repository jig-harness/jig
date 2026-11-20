/**
 * `jig ask pickup@…`: the item is read through the tracker interface the
 * checkout's configuration names (the GitHub adapter, over a fake GraphQL
 * endpoint), with its key checked against that tracker's form first; an item
 * assigned to the factory identity reads as assigned, an item the tracker
 * does not have exits 1, and a pick-up makes no forge call; a need whose
 * answer the tick could not read says why.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  issueNode,
  oneIssue,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import type {
  LineNeed,
  LineQueued,
  LineSnapshot,
} from "../../dispatch/lib/dashboard-contract.ts";
import {
  stationContextOf,
  stationDecision,
} from "../../dispatch/lib/line-station.ts";
import { writeLine } from "../../dispatch/lib/line-store.ts";
import { setPersonPickupHold } from "../../dispatch/lib/person-pickup-holds.ts";
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
  // The facets' stores named, so no detection read comes before the item's.
  writeFileSync(
    join(w.repo, ".config", "jig.yaml"),
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${REPO}\n  facets:\n    type: { store: label }\n    priority: { store: label }\ndispatch:\n  identity: factory-bot\n`,
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

/** The newest tick's line in `w`, with `needs` and `queue`. */
function writeLineOf(
  w: AskWorld,
  needs: LineNeed[],
  queue: LineQueued[] = [],
): void {
  const line = {
    version: 1,
    runId: "2026-11-12T10-00-00-000Z-1-aaaaaaaa",
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:01:00.000Z",
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    intervalMs: 300_000,
    longestTickMs: 60_000,
    plugin: "1.2.3",
    accounts: [],
    lastAccount: null,
    sessions: [],
    needs,
    queue,
    ready: [],
    repos: [],
  } as unknown as LineSnapshot;
  writeLine(line, "{}", w.state);
}

/** The newest tick's line in `w`, holding a stalled pickup need on #12 whose decision's answers did not read for `unread`. */
function unreadNeed(w: AskWorld, unread: string): void {
  const decision = stationDecision(
    {
      stage: "notify",
      target: "#12",
      record: "tracker",
      reason: "stalled pickup",
      cause: "stalled",
      evidence: { state: "In Progress" },
    },
    stationContextOf(REPO, {
      tracker: { adapter: "linear" },
      links: { itemsOf: () => null, prsOf: () => [] },
    }),
  );
  if (decision === null) throw new TypeError("the fixture frames no decision");
  const need: LineNeed = {
    cause: "stalled",
    stage: "pickup",
    repo: REPO,
    target: "#12",
    pr: null,
    item: "#12",
    url: null,
    title: null,
    since: "2026-11-12T10:00:00.000Z",
    reason: "stalled pickup",
    decisions: [{ ...decision, unread }],
    notified: null,
    workspaces: [],
  };
  writeLineOf(w, [need]);
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

  it("does not ask for the hold's release while a tracker claim still holds the item", async () => {
    const w = world();
    const set = setPersonPickupHold(
      REPO,
      "#13",
      { title: "A held item", url: "", by: "maintainer" },
      w.state,
    );
    if (!set.ok) throw new Error(JSON.stringify(set));
    const r = await w.ask([`pickup@${REPO}#13`, "--json"]);
    expectSpawnExit(r, 0);
    const answer = JSON.parse(r.stdout) as AskAnswer;
    expect(answer.state).toBe("held");
    expect(answer.holder).not.toBe("none");
    expect(JSON.stringify(answer.waitsOn)).not.toContain(
      "release the pickup hold",
    );
  });

  it("says a need's answer is unreadable, and why, rather than only that it waits", async () => {
    const w = world();
    const why =
      "the only answer on #12 is by Jig Factory, the user the dispatcher's own tracker credential acts as, whose comments the tick never counts as an answer";
    unreadNeed(w, why);
    const r = await w.ask([`pickup@${REPO}#12`, "--json"]);
    expectSpawnExit(r, 0);
    const { waitsOn } = JSON.parse(r.stdout) as AskAnswer;
    expect(
      typeof waitsOn === "object" && "why" in waitsOn ? waitsOn.why : "",
    ).toBe(`stalled pickup; its answers are unreadable: ${why}`);
  });

  it("says what an assigned pickup waits on for its overlap, and its footprint note, as the newest tick found them", async () => {
    const w = world();
    const overlap = {
      relation: "waits on overlap" as const,
      item: "#12",
      on: [
        {
          kind: "pull request" as const,
          ref: "#20",
          state: "open",
          url: `https://github.com/${REPO}/pull/20`,
        },
      ],
      count: 1,
      text: "waits on overlap: shares area dispatch with #20 (pull request); 0.2 rounds expected; first when a slot is free after work that does not overlap, or from 16:40 UTC",
    };
    const footprint =
      "footprint unknown: no footprint record; derived from its area labels (dispatch)";
    const queued = {
      source: "assigned",
      group: "starts",
      repo: REPO,
      target: "#12",
      pr: null,
      item: "#12",
      url: null,
      title: null,
      why: "assigned to factory-bot",
      stale: false,
      assignedBy: "maintainer",
      hold: null,
      launch: null,
      overlap,
      footprint,
    } satisfies LineQueued;
    writeLineOf(w, [], [queued]);
    const r = await w.ask([`pickup@${REPO}#12`, "--json"]);
    expectSpawnExit(r, 0);
    const answer = JSON.parse(r.stdout) as AskAnswer;
    expect(answer.waitsOn).toEqual({ waiting: overlap.text });
    expect(answer.overlap).toEqual(overlap);
    expect(answer.footprint).toBe(footprint);
    const text = await w.ask([`pickup@${REPO}#12`]);
    expectSpawnExit(text, 0);
    expect(text.stdout).toContain(`  overlap  ${overlap.text}`);
    expect(text.stdout).toContain(
      `#20 (pull request, open) https://github.com/${REPO}/pull/20`,
    );
    expect(text.stdout).toContain(`  footprint ${footprint}`);
    // A claimed item no longer waits to be picked up: the newest tick's overlap says nothing of it.
    writeLineOf(w, [], [{ ...queued, target: "#13", item: "#13" }]);
    const claimed = JSON.parse(
      (await w.ask([`pickup@${REPO}#13`, "--json"])).stdout,
    ) as AskAnswer;
    expect(claimed.overlap).toBeUndefined();
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
