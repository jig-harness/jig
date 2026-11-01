/**
 * `do-item`'s claim: refused when another session holds the issue, written
 * and re-read otherwise, standing down when another claim landed first;
 * over an in-memory tracker, then over the GitHub and Linear adapters'
 * fake transports, and the reads and write each adapter adds for it.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type ClaimTracker, claimIssue } from "../scripts/lib/claim.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import type { TrackerUser } from "../scripts/lib/tracker/port.ts";
import {
  conn,
  gitHub,
  issueNode,
  oneIssue,
  writes,
} from "./github-fixtures.ts";
import { FACTORY, issue, jira, MEMBER, routes } from "./jira-fixtures.ts";

const ME: TrackerUser = { id: "u-me", name: "factory" };
const DANA: TrackerUser = { id: "u-dana", name: "dana" };
const STATES = parseTrackerConfig({}).states;

/** One issue held in memory; `onWrite` runs after each write, as a racing claim would. */
function memory(
  state: string,
  holders: TrackerUser[],
  onWrite?: (issue: { state: string; holders: TrackerUser[] }) => void,
) {
  const held = { state, holders: [...holders] };
  const log: string[] = [];
  const tracker: ClaimTracker = {
    stateName: (s) => STATES[s],
    viewer: async () => ME,
    poolIssue: async (key) => ({
      identifier: key,
      title: "t",
      url: null,
      priority: 0,
      createdAt: "2026-10-01T00:00:00Z",
      state: { id: held.state, name: held.state, type: "unstarted" },
      assignee: held.holders[0] ?? null,
      labels: [],
      hasOpenChildren: false,
      truncated: [],
    }),
    assignees: async () => [...held.holders],
    assign: async (_key, user) => {
      log.push(`assign ${user.name}`);
      held.holders = [user];
      onWrite?.(held);
    },
    transition: async (_key, s) => {
      log.push(`transition ${s}`);
      held.state = STATES[s];
      onWrite?.(held);
    },
  };
  return { tracker, log, held };
}

describe("claimIssue", () => {
  it("refuses an issue already in progress, writing nothing", async () => {
    const { tracker, log } = memory("In Progress", []);
    expect(await claimIssue(tracker, "#5")).toEqual({
      outcome: "refused",
      issue: "#5",
      why: "in_progress",
      reason: "#5 is already In Progress: another session holds it",
    });
    expect(log).toEqual([]);
  });

  it("refuses an issue assigned to anyone else, writing nothing", async () => {
    const { tracker, log } = memory("Todo", [ME, DANA]);
    const result = await claimIssue(tracker, "#5");
    expect(result).toMatchObject({ outcome: "refused", why: "assigned" });
    expect(result.outcome === "refused" && result.reason).toBe(
      "#5 is assigned to dana, not to factory",
    );
    expect(log).toEqual([]);
  });

  it("claims a todo issue assigned to nobody: assigns it, then starts it", async () => {
    const { tracker, log, held } = memory("Todo", []);
    expect(await claimIssue(tracker, "#5")).toEqual({
      outcome: "claimed",
      issue: "#5",
      claimant: ME,
      state: "In Progress",
    });
    expect(log).toEqual(["assign factory", "transition in_progress"]);
    expect(held).toEqual({ state: "In Progress", holders: [ME] });
  });

  it("claims a todo issue already assigned to itself without assigning it again", async () => {
    const { tracker, log } = memory("Todo", [ME]);
    expect((await claimIssue(tracker, "#5")).outcome).toBe("claimed");
    expect(log).toEqual(["transition in_progress"]);
  });

  it("stands down when the re-read shows another assignee", async () => {
    const { tracker } = memory("Todo", [], (held) => {
      // Another session's claim lands between this one's writes and its re-read.
      if (held.state === "In Progress") held.holders = [DANA];
    });
    expect(await claimIssue(tracker, "#5")).toEqual({
      outcome: "stood_down",
      issue: "#5",
      reason: "another claim landed first: #5 is now assigned to dana",
    });
  });

  it("stands down when the re-read shows the issue moved out of progress", async () => {
    const { tracker } = memory("Todo", [ME], (held) => {
      held.state = "Backlog";
    });
    expect(await claimIssue(tracker, "#5")).toMatchObject({
      outcome: "stood_down",
      reason: "another change landed first: #5 is now Backlog, not In Progress",
    });
  });
});

describe("GitHub adapter: claiming", () => {
  /** Issue #5 on a fake GitHub that applies the claim's writes. */
  function world(labels: string[], logins: string[], race?: string) {
    let state = { labels, logins };
    const user = (login: string) => ({ id: `U_${login}`, login });
    const fake = gitHub((c) => {
      if (c.op === "TrackerViewer") return { viewer: user("factory") };
      if (c.op === "TrackerAssignees")
        return {
          repository: {
            issue: {
              id: "I_5",
              assignees: {
                totalCount: state.logins.length,
                nodes: state.logins.map(user),
              },
            },
          },
        };
      if (c.op === "TrackerIssue")
        return oneIssue(
          issueNode({
            number: 5,
            labels: state.labels,
            assignee: state.logins[0] ?? null,
            extra: { subIssues: conn([]) },
          }),
        );
      if (c.op === "TrackerLabels")
        return {
          repository: { labels: conn([{ id: "LA_ip", name: "In Progress" }]) },
        };
      if (c.op === "TrackerAssign") {
        const ids = (c.variables.input as { assigneeIds: string[] })
          .assigneeIds;
        state = { ...state, logins: ids.map((id) => id.slice(2)) };
        return { updateIssue: { issue: { id: "I_5" } } };
      }
      if (c.op === "TrackerAddLabels") {
        state = {
          labels: [...state.labels, "In Progress"],
          logins: race === undefined ? state.logins : [race],
        };
        return { addLabelsToLabelable: { clientMutationId: null } };
      }
      throw new Error(`unexpected ${c.op}`);
    });
    return { ...fake, now: () => state };
  }

  it("claims a todo issue assigned to nobody", async () => {
    const w = world([], []);
    expect((await claimIssue(w.t, "#5")).outcome).toBe("claimed");
    expect(writes(w.calls)).toEqual(["TrackerAssign", "TrackerAddLabels"]);
    expect(w.calls.find((c) => c.op === "TrackerAssign")?.variables).toEqual({
      input: { id: "I_5", assigneeIds: ["U_factory"] },
    });
    expect(w.now()).toEqual({ labels: ["In Progress"], logins: ["factory"] });
  });

  it("refuses an issue in progress or assigned to another login", async () => {
    const started = world(["In Progress"], ["factory"]);
    expect((await claimIssue(started.t, "#5")).outcome).toBe("refused");
    const taken = world([], ["dana"]);
    expect(await claimIssue(taken.t, "#5")).toMatchObject({
      outcome: "refused",
      why: "assigned",
    });
    expect([...writes(started.calls), ...writes(taken.calls)]).toEqual([]);
  });

  it("stands down when another login took the issue before the re-read", async () => {
    const w = world([], ["factory"], "dana");
    expect(await claimIssue(w.t, "#5")).toMatchObject({
      outcome: "stood_down",
      reason: "another claim landed first: #5 is now assigned to dana",
    });
  });

  it("refuses to read assignees it cannot read in full", async () => {
    const { t } = gitHub(() => ({
      repository: {
        issue: {
          id: "I_5",
          assignees: { totalCount: 11, nodes: [{ id: "U_a", login: "a" }] },
        },
      },
    }));
    await expect(t.assignees("#5")).rejects.toThrow(
      "could not be read in full",
    );
  });
});

describe("tracker.ts claim", () => {
  /** Run `tracker.ts claim #5` against a GraphQL endpoint answering as `world` does. */
  async function cli(labels: string[], logins: string[], race?: string) {
    let state = { labels, logins };
    const user = (login: string) => ({ id: `U_${login}`, login });
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        const { query, variables } = (await request.json()) as {
          query: string;
          variables: Record<string, unknown>;
        };
        const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
        let data: unknown;
        if (op === "TrackerViewer") data = { viewer: user("factory") };
        if (op === "TrackerAssignees")
          data = {
            repository: {
              issue: {
                id: "I_5",
                assignees: {
                  totalCount: state.logins.length,
                  nodes: state.logins.map(user),
                },
              },
            },
          };
        if (op === "TrackerIssue")
          data = oneIssue(
            issueNode({
              number: 5,
              labels: state.labels,
              assignee: state.logins[0] ?? null,
              extra: { subIssues: conn([]) },
            }),
          );
        if (op === "TrackerLabels")
          data = {
            repository: {
              labels: conn([{ id: "LA_ip", name: "In Progress" }]),
            },
          };
        if (op === "TrackerAssign") {
          const input = variables.input as { assigneeIds: string[] };
          state = {
            ...state,
            logins: input.assigneeIds.map((i) => i.slice(2)),
          };
          data = { updateIssue: { issue: { id: "I_5" } } };
        }
        if (op === "TrackerAddLabels") {
          state = {
            labels: [...state.labels, "In Progress"],
            logins: race === undefined ? state.logins : [race],
          };
          data = { addLabelsToLabelable: { clientMutationId: null } };
        }
        return Response.json(
          data === undefined
            ? { errors: [{ message: `unhandled ${op}` }] }
            : { data },
        );
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "jig-claim-"));
    const overlay = join(dir, "overlay.yaml");
    writeFileSync(
      overlay,
      "issue_tracker:\n  adapter: github\n  github:\n    repository: acme/app\n",
    );
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../scripts/tracker.ts"),
          "claim",
          "#5",
        ],
        {
          cwd: dir,
          env: {
            ...process.env,
            JIG_OVERLAY: overlay,
            JIG_USER_LAYER: "off",
            JIG_GITHUB_GRAPHQL_URL: `http://127.0.0.1:${server.port}/graphql`,
            GH_TOKEN: "test-token",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exits 0 with the claim, 3 on a refusal and 4 on a stand-down, printing the reason", async () => {
    const claimed = await cli([], []);
    expectSpawnExit(claimed, 0);
    expect(JSON.parse(claimed.stdout).outcome).toBe("claimed");

    const refused = await cli(["In Progress"], ["dana"]);
    expectSpawnExit(refused, 3);
    expect(refused.stderr).toContain("#5 is already In Progress");

    const stood = await cli([], [], "dana");
    expectSpawnExit(stood, 4);
    expect(stood.stderr).toContain("another claim landed first");
  });
});

describe("Linear adapter: claiming", () => {
  function world(
    stateName: string,
    assignee: TrackerUser | null,
    race = false,
  ) {
    let state = { stateName, assignee };
    const calls: string[] = [];
    const STATE_IDS: Record<string, string> = {
      Todo: "s-todo",
      "In Progress": "s-ip",
    };
    const transport: LinearTransport = async (query, variables) => {
      const op = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? "?";
      calls.push(op);
      const user = (u: TrackerUser | null) =>
        u === null ? null : { id: u.id, name: u.name };
      switch (op) {
        case "TrackerViewer":
          return { viewer: user(ME) };
        case "TrackerAssignee":
          return { issue: { id: "uuid-4", assignee: user(state.assignee) } };
        case "TrackerPoolIssue":
          return {
            issue: {
              identifier: "ENG-4",
              title: "t",
              url: null,
              priority: 0,
              createdAt: "2026-09-01T00:00:00.000Z",
              state: {
                id: STATE_IDS[state.stateName],
                name: state.stateName,
                type: "unstarted",
              },
              assignee: user(state.assignee),
              labels: { pageInfo: { hasNextPage: false }, nodes: [] },
              children: { pageInfo: { hasNextPage: false }, nodes: [] },
            },
          };
        case "TrackerAssign":
          expect(variables).toEqual({
            id: "uuid-4",
            input: { assigneeId: ME.id },
          });
          state = { ...state, assignee: ME };
          return { issueUpdate: { success: true } };
        case "TrackerIssueId":
          return { issue: { id: "uuid-4", team: { id: "t-1", key: "ENG" } } };
        case "TrackerStates":
          return {
            team: {
              states: {
                pageInfo: { hasNextPage: false },
                nodes: Object.entries(STATE_IDS).map(([name, id]) => ({
                  id,
                  name,
                  type: "unstarted",
                })),
              },
            },
          };
        case "TrackerUpdate":
          state = {
            stateName: "In Progress",
            assignee: race ? DANA : state.assignee,
          };
          return { issueUpdate: { success: true } };
        default:
          throw new Error(`unexpected ${op}`);
      }
    };
    return {
      t: linearTracker({ team: "ENG", states: STATES, transport }),
      calls,
      now: () => state,
    };
  }

  it("claims a todo issue assigned to nobody", async () => {
    const w = world("Todo", null);
    expect((await claimIssue(w.t, "ENG-4")).outcome).toBe("claimed");
    expect(
      w.calls.filter((op) => op === "TrackerAssign" || op === "TrackerUpdate"),
    ).toEqual(["TrackerAssign", "TrackerUpdate"]);
    expect(w.now()).toEqual({ stateName: "In Progress", assignee: ME });
  });

  it("refuses an issue in progress or assigned to another user", async () => {
    expect(
      (await claimIssue(world("In Progress", null).t, "ENG-4")).outcome,
    ).toBe("refused");
    const taken = world("Todo", DANA);
    expect(await claimIssue(taken.t, "ENG-4")).toMatchObject({
      outcome: "refused",
      why: "assigned",
    });
    expect(taken.calls).not.toContain("TrackerAssign");
  });

  it("stands down when another user took the issue before the re-read", async () => {
    expect(await claimIssue(world("Todo", ME, true).t, "ENG-4")).toMatchObject({
      outcome: "stood_down",
    });
  });
});

describe("Jira adapter: the claim's reads and write", () => {
  it("names the credential's account, the assignee, and assigns by account id", async () => {
    const { t, calls } = jira(
      routes({
        "GET myself": FACTORY,
        "GET issue/ENG-1": issue({ key: "ENG-1", assignee: MEMBER }),
        "PUT issue/ENG-1/assignee": null,
      }),
    );
    expect(await t.viewer()).toEqual({
      id: FACTORY.accountId,
      name: FACTORY.displayName,
    });
    expect(await t.assignees("ENG-1")).toEqual([
      { id: MEMBER.accountId, name: MEMBER.displayName },
    ]);
    await t.assign("ENG-1", { id: FACTORY.accountId, name: "x" });
    expect(calls.at(-1)?.body).toEqual({ accountId: FACTORY.accountId });
  });

  it("reads an unassigned issue as nobody's", async () => {
    const { t } = jira(routes({ "GET issue/ENG-2": issue({ key: "ENG-2" }) }));
    expect(await t.assignees("ENG-2")).toEqual([]);
  });
});
