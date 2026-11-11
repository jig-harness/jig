/**
 * `do-item`'s claim: refused when another session holds the issue, written
 * and re-read otherwise, standing down when another claim landed first;
 * over an in-memory tracker, then over the GitHub and Linear adapters'
 * fake transports, and the reads and write each adapter adds for it.
 */
import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { type ClaimTracker, claimIssue } from "../scripts/lib/claim.ts";
import {
  claimMarkerBody,
  readClaimMarker,
} from "../scripts/lib/claim-marker.ts";
import { parseTrackerConfig } from "../scripts/lib/tracker/config.ts";
import {
  type LinearTransport,
  linearTracker,
} from "../scripts/lib/tracker/linear.ts";
import {
  type StateNames,
  stateNameIn,
  type TrackerUser,
} from "../scripts/lib/tracker/port.ts";
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
  states: StateNames = STATES,
) {
  const held = { state, holders: [...holders] };
  const log: string[] = [];
  const tracker: ClaimTracker = {
    stateName: stateNameIn(states),
    viewer: async () => ME,
    poolIssue: async (key) => ({
      identifier: key,
      title: "t",
      url: null,
      priority: 0,
      type: null,
      size: null,
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
      held.state = states[s] ?? held.state;
      onWrite?.(held);
    },
  };
  return { tracker, log, held };
}

describe("claimIssue", () => {
  it("refuses an issue whose pull request is open, writing nothing", async () => {
    const states = parseTrackerConfig({
      issue_tracker: { states: { pr_open: "Awaiting Review" } },
    }).states;
    const { tracker, log } = memory("Awaiting Review", [], undefined, states);
    expect(await claimIssue(tracker, "#5")).toEqual({
      outcome: "refused",
      issue: "#5",
      why: "pr_open",
      reason: "#5 is Awaiting Review: its pull request is open",
    });
    expect(log).toEqual([]);
  });

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

  describe("with claim_from", () => {
    const todoOnly = { claimFrom: ["todo"] as const };

    it("claims an item in a listed state", async () => {
      const { tracker } = memory("Todo", []);
      expect(
        (await claimIssue(tracker, "#5", { claimFrom: ["todo"] })).outcome,
      ).toBe("claimed");
    });

    it("refuses an item in backlog, naming the state and the allowed ones, writing nothing", async () => {
      const { tracker, log } = memory("Backlog", []);
      expect(
        await claimIssue(tracker, "#5", { claimFrom: [...todoOnly.claimFrom] }),
      ).toEqual({
        outcome: "refused",
        issue: "#5",
        why: "state",
        reason:
          "#5 is in Backlog (backlog); do_item.claim_from lets work start only from todo (Todo)",
      });
      expect(log).toEqual([]);
    });

    it("refuses an item in a side state with a canonical name outside the list, writing nothing", async () => {
      const { tracker, log } = memory("In Review", []);
      const result = await claimIssue(tracker, "#5", { claimFrom: ["todo"] });
      expect(result).toMatchObject({ outcome: "refused", why: "state" });
      expect(log).toEqual([]);
    });

    it("refuses a status that maps to no canonical state, writing nothing", async () => {
      const { tracker, log } = memory("Blocked", []);
      const result = await claimIssue(tracker, "#5", { claimFrom: ["todo"] });
      expect(result).toMatchObject({ outcome: "refused", why: "state" });
      expect(result.outcome === "refused" && result.reason).toContain(
        "maps to no canonical state",
      );
      expect(log).toEqual([]);
    });

    it("unset, claims from any state but in progress", async () => {
      for (const state of ["Backlog", "Blocked"]) {
        const { tracker } = memory(state, []);
        expect((await claimIssue(tracker, "#5")).outcome).toBe("claimed");
      }
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

const FIXTURE = join(import.meta.dir, "fixtures", "preflight-fixture.ts");

/** Make `dir` a clone whose default branch (`origin/HEAD`) holds `config` as `.config/jig.yaml`. */
function defaultBranch(dir: string, config: string): void {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".config"));
  writeFileSync(join(dir, ".config", "jig.yaml"), config);
  git("add", ".config/jig.yaml");
  git("commit", "-q", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
}

describe("tracker.ts claim", () => {
  /** Run `tracker.ts claim #5` against a GraphQL endpoint answering as `world` does. */
  async function cli(
    labels: string[],
    logins: string[],
    race?: string,
    extra: {
      overlay?: string;
      env?: Record<string, string>;
      /** The default branch's `.config/jig.yaml` additions; absent, the clone names no default branch. */
      committed?: string;
      /** Requests the fake tracker records, by operation. */
      seen?: string[];
      /** The item's comments before the claim, as GitHub's comment nodes. */
      comments?: Array<Record<string, unknown>>;
      /** Fail the claim's comment post. */
      failComment?: boolean;
    } = {},
  ) {
    let state = { labels, logins };
    const comments = [...(extra.comments ?? [])];
    const writeOps: string[] = [];
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
        if (op === "TrackerAssign") writeOps.push(op);
        if (op === "TrackerAddLabels") writeOps.push(op);
        if (op !== undefined) extra.seen?.push(op);
        if (op === "TrackerComment" && extra.failComment !== true) {
          writeOps.push(`${op} ${String(variables.body)}`);
          comments.push({
            id: `IC_${comments.length + 1}`,
            body: String(variables.body),
            createdAt: new Date().toISOString(),
            authorAssociation: "NONE",
            viewerDidAuthor: true,
          });
          data = { addComment: { clientMutationId: null } };
        }
        if (op === "TrackerComments")
          data = {
            repository: { issue: { id: "I_5", comments: conn(comments) } },
          };
        if (op === "TrackerDeleteComment") {
          writeOps.push(`${op} ${String(variables.id)}`);
          const at = comments.findIndex((c) => c.id === variables.id);
          if (at >= 0) comments.splice(at, 1);
          data = { deleteIssueComment: { clientMutationId: null } };
        }
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
    // Both facets named, so no detection read precedes the claim's.
    const base =
      "issue_tracker:\n  adapter: github\n  github:\n    repository: acme/app\n  facets:\n    type: { store: label }\n    priority: { store: label }\n";
    writeFileSync(overlay, base + (extra.overlay ?? ""));
    if (extra.committed !== undefined)
      defaultBranch(dir, base + extra.committed);
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
            ...extra.env,
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
      const seen = existsSync(join(dir, "seen.json"))
        ? readFileSync(join(dir, "seen.json"), "utf8")
        : null;
      return { exitCode, stdout, stderr, writes: writeOps, seen };
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

  it("refuses an item outside do_item.claim_from with exit 3, writing nothing", async () => {
    const out = await cli([], [], undefined, {
      committed: "do_item:\n  claim_from: [in_review]\n",
    });
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout)).toMatchObject({
      outcome: "refused",
      why: "state",
    });
    expect(out.writes).toEqual([]);
  });

  it("ignores a do_item.claim_from only the working tree sets", async () => {
    const out = await cli([], [], undefined, {
      overlay: "do_item:\n  claim_from: [in_review]\n",
      committed: "",
    });
    expectSpawnExit(out, 0);
    expect(JSON.parse(out.stdout).outcome).toBe("claimed");
  });

  it("posts the claim marker before the claim's writes with do_item.claim_marker", async () => {
    const out = await cli([], [], undefined, {
      committed: "do_item:\n  claim_marker: true\n",
      env: { CLAUDE_CODE_SESSION_ID: "session-1" },
    });
    expectSpawnExit(out, 0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      outcome: "claimed",
      marker: { posted: true, confirmed: true },
    });
    const comment = out.writes.find((w) => w.startsWith("TrackerComment "));
    expect(comment).toBeDefined();
    expect(comment).toContain("<!-- jig-claim -->");
    expect(comment).toContain('"kind":"tracker-claim-marker"');
    expect(comment).toContain('"session":"session-1"');
    expect(comment).toContain("Claimed by factory · session session-1");
    expect(
      readClaimMarker((comment as string).slice("TrackerComment ".length)),
    ).toMatchObject({ session: "session-1", claimant: "factory" });
    // The marker comes first, then the claim's own writes.
    expect(out.writes).toEqual([
      comment as string,
      "TrackerAssign",
      "TrackerAddLabels",
    ]);
  });

  it("refuses with exit 3, writing nothing to the item, when another claim's marker is earlier", async () => {
    const theirs = claimMarkerBody({
      attempt: "other-host",
      session: "session-2",
      branch: "main",
      claimant: "factory",
      at: new Date().toISOString(),
    });
    const out = await cli([], [], undefined, {
      committed: "do_item:\n  claim_marker: true\n",
      comments: [
        {
          id: "IC_0",
          body: theirs,
          createdAt: new Date(Date.now() - 60_000).toISOString(),
          authorAssociation: "MEMBER",
          viewerDidAuthor: false,
        },
      ],
    });
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout)).toMatchObject({
      outcome: "refused",
      why: "marker",
    });
    expect(out.stderr).toContain("another claim's marker on #5 is earlier");
    // Its own marker posted, then withdrawn; the item untouched.
    expect(out.writes.map((w) => w.split(" ")[0])).toEqual([
      "TrackerComment",
      "TrackerDeleteComment",
    ]);
  });

  it("refuses with exit 3, writing nothing, when its marker cannot be posted", async () => {
    const out = await cli([], [], undefined, {
      committed: "do_item:\n  claim_marker: true\n",
      failComment: true,
    });
    expectSpawnExit(out, 3);
    expect(JSON.parse(out.stdout)).toMatchObject({
      outcome: "refused",
      why: "marker",
    });
    expect(out.stderr).toContain("could not be posted");
    expect(out.writes).toEqual([]);
  });

  it("posts no marker without do_item.claim_marker", async () => {
    const out = await cli([], []);
    expectSpawnExit(out, 0);
    expect(JSON.parse(out.stdout).marker).toBeUndefined();
    expect(out.writes.some((w) => w.startsWith("TrackerComment"))).toBe(false);
  });

  describe("the preflight command", () => {
    // The command is read from the default branch, never the working tree.
    const claimWith = (committed: string, env: Record<string, string> = {}) =>
      cli([], [], undefined, { committed, env });
    const preflight = (command: string) =>
      `do_item:\n  preflight_command: ${JSON.stringify(command)}\n`;
    // The tracker's mock answers the claim's own reads; these run the real script.
    const run = (mode: string, env: Record<string, string> = {}) =>
      claimWith(preflight(`bun ${JSON.stringify(FIXTURE)} ${mode}`), env);

    it("runs it with the issue's JSON on stdin, and claims when it exits 0", async () => {
      const out = await run("save");
      expectSpawnExit(out, 0);
      expect(JSON.parse(out.stdout).outcome).toBe("claimed");
      expect(JSON.parse(out.seen as string)).toMatchObject({
        found: true,
        identifier: "#5",
      });
      expect(out.writes.length).toBeGreaterThan(0);
    });

    it("refuses on exit 3 with its first line as the reason, writing nothing", async () => {
      const out = await run("refuse");
      expectSpawnExit(out, 3);
      expect(JSON.parse(out.stdout)).toMatchObject({
        outcome: "refused",
        why: "preflight",
      });
      expect(out.stderr).toContain("other repo");
      expect(out.stderr).not.toContain("more");
      expect(out.writes).toEqual([]);
    });

    it("refuses on any other exit, naming it, writing nothing", async () => {
      const out = await run("fail");
      expectSpawnExit(out, 3);
      expect(out.stderr).toContain("failed (exit 2: broke)");
      expect(out.writes).toEqual([]);
    });

    it("refuses a command still running past the deadline, writing nothing", async () => {
      const out = await run("hang", {
        JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC: "1",
      });
      expectSpawnExit(out, 3);
      expect(out.stderr).toContain("still running after 1s");
      expect(out.writes).toEqual([]);
    });

    it("refuses a malformed deadline instead of running unbounded", async () => {
      const out = await run("ok", {
        JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC: "0",
      });
      expectSpawnExit(out, 3);
      expect(out.stderr).toContain("JIG_DO_ITEM_PREFLIGHT_TIMEOUT_SEC");
      expect(out.writes).toEqual([]);
    });

    it("fails the claim, writing nothing, when the setting is not a command", async () => {
      const out = await claimWith("do_item:\n  preflight_command: 5\n");
      expectSpawnExit(out, 1);
      expect(out.stderr).toContain("do_item.preflight_command");
      expect(out.writes).toEqual([]);
    });

    it("carries the item's updatedAt on a refusal, for the dispatcher's hold", async () => {
      const out = await run("refuse");
      expectSpawnExit(out, 3);
      expect(JSON.parse(out.stdout).updatedAt).toBe("2026-01-02T00:00:00Z");
    });

    it("never runs a command only the working tree sets", async () => {
      const out = await cli([], [], undefined, {
        committed: "",
        overlay: preflight(`bun ${FIXTURE} refuse`),
      });
      expectSpawnExit(out, 0);
      expect(JSON.parse(out.stdout).outcome).toBe("claimed");
    });

    it("refuses, writing nothing, when the working tree sets a command and no default branch can be read", async () => {
      const out = await cli([], [], undefined, {
        overlay: preflight(`bun ${FIXTURE} ok`),
      });
      expectSpawnExit(out, 3);
      expect(out.stderr).toContain("read from the default branch");
      expect(out.writes).toEqual([]);
    });
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

describe("each adapter: the user an identity names", () => {
  it("GitHub names a login's user, and refuses a login with none", async () => {
    const { t, calls } = gitHub((call) =>
      call.variables.login === "factory-bot"
        ? { user: { id: "U_factory", login: "factory-bot" } }
        : { user: null },
    );
    expect(await t.user("factory-bot")).toEqual({
      id: "U_factory",
      name: "factory-bot",
    });
    expect(calls.map((c) => c.op)).toEqual(["TrackerUser"]);
    await expect(t.user("nobody-here")).rejects.toThrow(
      'GitHub has no user "nobody-here"',
    );
  });

  it("Linear names the one user an email or a display name matches, and refuses none or two", async () => {
    const users: Record<string, Array<{ id: string; name: string }>> = {
      "factory@example.com": [{ id: "u-f", name: "Factory" }],
      twin: [
        { id: "u-1", name: "Twin" },
        { id: "u-2", name: "Twin" },
      ],
    };
    const transport: LinearTransport = async (query, variables) => {
      expect(query).toContain("query TrackerUsers");
      return { users: { nodes: users[String(variables.who)] ?? [] } };
    };
    const t = linearTracker({ team: "ENG", states: STATES, transport });
    expect(await t.user("factory@example.com")).toEqual({
      id: "u-f",
      name: "Factory",
    });
    await expect(t.user("twin")).rejects.toThrow("more than one Linear user");
    await expect(t.user("ghost")).rejects.toThrow("names no Linear user");
  });

  it("Jira names the account an id confirms", async () => {
    const { t } = jira(routes({ "GET user": FACTORY }));
    expect(await t.user(FACTORY.accountId)).toEqual({
      id: FACTORY.accountId,
      name: FACTORY.accountId,
    });
  });
});
