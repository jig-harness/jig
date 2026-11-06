/**
 * `jig send pickup@… assign`: the item is read and written through the
 * tracker interface the checkout's configuration names (the GitHub adapter,
 * over a fake GraphQL endpoint). `--dry-run` names the tracker's user it
 * writes as and the assignment, and writes nothing; a real send assigns the
 * item to the factory identity; an item someone holds, or a repository that
 * names no factory identity, is refused before any write.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  issueNode,
  oneIssue,
} from "../../skills/do-item/__tests__/github-fixtures.ts";
import { REPO, type SendWorld, sendWorld } from "./send-fixtures.ts";

let current: SendWorld | null = null;
let server: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  server?.stop(true);
  server = null;
  current?.close();
  current = null;
});

const NO_PAGE = { pageInfo: { hasNextPage: false, endCursor: null } };
const SUB = { subIssues: { pageInfo: { hasNextPage: false }, nodes: [] } };

/** A world whose tracker holds #14 (nobody's) and #15 (dana's); `ops` logs each GraphQL operation. */
function world(identity: string | null = "factory-bot") {
  const w = sendWorld();
  current = w;
  const ops: Array<{ op: string; variables: Record<string, unknown> }> = [];
  let assigned = false;
  // The tick reads the identity from the default branch, so the checkout's own file does not set it.
  if (identity !== null) w.config(`dispatch:\n  identity: ${identity}\n`);
  mkdirSync(join(w.repo, ".config"), { recursive: true });
  writeFileSync(
    join(w.repo, ".config", "jig.yaml"),
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${REPO}\n`,
  );
  const issue = (n: number) =>
    issueNode({
      number: n,
      repo: REPO,
      assignee: n === 15 ? "dana" : null,
      extra: SUB,
    });
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { query, variables } = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      ops.push({ op, variables });
      if (op === "TrackerAssign") assigned = true;
      const answers: Record<string, unknown> = {
        TrackerViewer: { viewer: { id: "U_maintainer", login: "maintainer" } },
        TrackerIssue: oneIssue(
          variables.number === 14 || variables.number === 15
            ? issue(Number(variables.number))
            : null,
        ),
        TrackerIssues: { repository: { issues: { ...NO_PAGE, nodes: [] } } },
        TrackerUser: { user: { id: "U_factory-bot", login: "factory-bot" } },
        TrackerAssignees: {
          repository: {
            issue: {
              id: "I_14",
              assignees: assigned
                ? {
                    totalCount: 1,
                    nodes: [{ id: "U_factory-bot", login: "factory-bot" }],
                  }
                : { totalCount: 0, nodes: [] },
            },
          },
        },
        TrackerAssign: { updateIssue: { issue: { id: "I_14" } } },
      };
      return Response.json(
        op in answers
          ? { data: answers[op] }
          : { errors: [{ message: `unhandled ${op}` }] },
      );
    },
  });
  w.env.JIG_GITHUB_GRAPHQL_URL = `http://127.0.0.1:${server.port}/graphql`;
  return { w, ops };
}

const writes = (ops: Array<{ op: string }>) =>
  ops.filter((o) => o.op === "TrackerAssign").map((o) => o.op);

describe("jig send assign", () => {
  it("prints the tracker's user and the assignment on --dry-run, and writes nothing", async () => {
    const { w, ops } = world();
    const r = await w.send([`pickup@${REPO}#14`, "assign", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(`repository ${REPO}`);
    expect(r.stdout).toContain(
      "writes as  maintainer, the user the tracker's credential acts as here",
    );
    expect(r.stdout).toContain(
      "#14 assigned to factory-bot, in Todo, a dispatch state",
    );
    expect(r.stdout).toContain("starts the pick-up");
    expect(writes(ops)).toEqual([]);
    // The forge is read for the default branch's configuration and written nowhere.
    expect(w.calls()).toEqual([
      `api -i repos/${REPO}/contents/.config/jig.yaml`,
    ]);
  });

  it("assigns the item to the factory identity", async () => {
    const { w, ops } = world();
    const r = await w.send([`pickup@${REPO}#14`, "assign"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      `sent       https://github.com/${REPO}/issues/14`,
    );
    expect(ops.find((o) => o.op === "TrackerAssign")?.variables).toEqual({
      input: { id: "I_14", assigneeIds: ["U_factory-bot"] },
    });
  });

  it("refuses an item someone holds, and a repository with no factory identity", async () => {
    const held = world();
    const r = await held.w.send([`pickup@${REPO}#15`, "assign"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("#15 is assigned to dana");
    expect(writes(held.ops)).toEqual([]);
    server?.stop(true);
    current?.close();
    const none = world(null);
    const r2 = await none.w.send([`pickup@${REPO}#14`, "assign"]);
    expectSpawnExit(r2, 1);
    expect(r2.stderr).toContain("set dispatch.identity");
    expect(writes(none.ops)).toEqual([]);
  });

  it("takes the tracker from the default branch, not the checkout", async () => {
    const { w, ops } = world();
    w.config(
      "dispatch:\n  identity: factory-bot\nissue_tracker:\n  adapter: linear\n  linear:\n    team: ENG\n",
    );
    const r = await w.send([`pickup@${REPO}#14`, "assign"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("not an item key of the tracker");
    expect(writes(ops)).toEqual([]);
  });
});
