/**
 * dispatch --apply: pickups. An item assigned to the factory identity gets
 * one workspace and one `do-item` session, once, where the runtime binds an
 * interactive session to its account (`bound-tick.ts` fakes Orca's answer
 * true); with Orca's real answer, the pickup is reported and nothing starts.
 * Stalled pickups and double claims are reported, never launched.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRecordFile } from "../lib/launches.ts";
import { updateIdle } from "../lib/idle.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  recordIds,
  waitFor,
} from "./launch-fixtures.ts";
import {
  applyTick,
  claudeRuns,
  orcaCalls,
  withOrigin,
} from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`;

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** Issue #12 assigned to the factory identity by a writer, one account, `pickup` enabled. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
  return w;
}

const launches = (r: { repos: Array<{ launches: unknown[] }> }) =>
  (r.repos[0]?.launches ?? []) as Array<Record<string, unknown>>;

describe("jig dispatch --apply picks up assigned items", () => {
  it("gives an assigned todo item exactly one workspace and one session across three ticks", async () => {
    const w = fixture();
    w.env.CLAUDE_CODE_OAUTH_TOKEN = "a-token-for-another-account";

    const first = await applyTick(w, true);
    const [launched] = launches(first);
    expect(launched).toMatchObject({
      action: "pickup",
      target: "#12",
      outcome: "launched",
      account: "a",
    });
    const id = String(launched?.record);
    const record = readRecordFile(id, dispatchState(w));
    expect(record?.agentId).toBe("tab-1:leaf-1");
    expect(record?.item).toBe("#12");
    const [create] = orcaCalls(w, "worktree", "create");
    expect(create).toContain("--issue");
    expect(create?.[create.indexOf("--issue") + 1]).toBe("12");
    expect(create?.[create.indexOf("--name") + 1]).toBe("12-issue-12");

    await waitFor("the session", () => claudeRuns(w).length === 1);
    const [session] = claudeRuns(w);
    expect(session?.configDir).toBe(join(w.root, "config-a"));
    expect(session?.token).toBeNull();
    const prompt = session?.argv.at(-1) ?? "";
    expect(prompt.startsWith("/jig:do-item #12\n")).toBe(true);
    expect(prompt).toContain(`dispatch result ${id} ${record?.token} done`);

    // The session is starting: its wrapper runs, Orca does not report its agent yet.
    const second = await applyTick(w, true);
    expect(launches(second)).toEqual([]);
    expect(second.repos[0]?.running.map((r) => r.target)).toEqual(["#12"]);

    // Orca reports the agent working in the item's workspace.
    w.setWorkspaces([
      {
        branch: "12-issue-12",
        path: record?.workspace?.path ?? "",
        agents: [{ state: "working", paneKey: "tab-1:leaf-1" }],
      },
    ]);
    const third = await applyTick(w, true);
    expect(launches(third)).toEqual([]);
    expect(third.repos[0]?.running[0]?.reason).toContain(`launch record ${id}`);

    expect(orcaCalls(w, "worktree", "create")).toHaveLength(1);
    expect(orcaCalls(w, "terminal", "create")).toHaveLength(1);
    expect(claudeRuns(w)).toHaveLength(1);
    expect(recordIds(w)).toEqual([id]);
  });

  it("does not pick an item up again once its session ended without claiming it", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, true))[0]?.record);
    const path = readRecordFile(id, dispatchState(w))?.workspace?.path ?? "";
    w.setWorkspaces([
      {
        branch: "12-issue-12",
        path,
        agents: [{ state: "done", paneKey: "tab-1:leaf-1" }],
      },
    ]);
    const later = await applyTick(w, true);
    expect(launches(later)).toEqual([]);
    expect(later.repos[0]?.quiet).toContainEqual(
      expect.objectContaining({ target: "#12", class: "pickup-ended" }),
    );
    expect(orcaCalls(w, "terminal", "create")).toHaveLength(1);
  });

  it("launches nothing for an item unassigned between the report and the launch", async () => {
    const w = fixture();
    // The plan's two listings (dispatch states, then in progress) see it; the fresh read does not.
    w.setIssuesAfter(2, []);
    const [waiting] = launches(await applyTick(w, true));
    expect(waiting).toMatchObject({
      action: "pickup",
      outcome: "waits",
      detail: "it is no longer assigned to factory-bot in todo",
    });
    expect(orcaCalls(w, "worktree", "create")).toEqual([]);
    expect(orcaCalls(w, "terminal", "create")).toEqual([]);
    expect(recordIds(w)).toEqual([]);
  });

  it("launches nothing for an item moved back to the backlog before the launch", async () => {
    const w = fixture();
    w.setIssuesAfter(2, [assignedIssue(12, "factory-bot", ["Backlog"])]);
    expect(launches(await applyTick(w, true))[0]).toMatchObject({
      outcome: "waits",
      detail: "it is no longer assigned to factory-bot in todo",
    });
    expect(orcaCalls(w, "terminal", "create")).toEqual([]);
    expect(recordIds(w)).toEqual([]);
  });

  it("reports a stalled pickup and never relaunches it", async () => {
    const w = fixture();
    w.setIssues([assignedIssue(12, "factory-bot", ["In Progress"])]);
    // Idle since an hour ago: past the 30-minute default.
    updateIdle(SLUG, ["#12"], Date.now() - 3_600_000, dispatchState(w));
    const receipt = await applyTick(w, true);
    const [stalled] = receipt.repos[0]?.actions ?? [];
    expect(stalled).toMatchObject({
      stage: "notify",
      target: "#12",
      cause: "stalled",
    });
    expect(stalled?.reason).toContain("stalled pickup");
    expect(launches(receipt)).toEqual([]);
    expect(orcaCalls(w, "terminal", "create")).toEqual([]);
  });

  it("starts the stall clock the first time a claimed item is idle", async () => {
    const w = fixture();
    w.setIssues([assignedIssue(12, "factory-bot", ["In Progress"])]);
    const receipt = await applyTick(w, true);
    expect(receipt.repos[0]?.actions).toEqual([]);
    expect(receipt.repos[0]?.quiet).toContainEqual(
      expect.objectContaining({ target: "#12", class: "claimed-idle" }),
    );
  });

  it("reports a double claim and starts nothing for it", async () => {
    const w = fixture();
    w.setWorkspaces([
      { branch: "12-issue-12", agents: [{ state: "working" }] },
      { branch: "12-another-try", agents: [{ state: "waiting" }] },
    ]);
    const receipt = await applyTick(w, true);
    expect(receipt.repos[0]?.actions).toEqual([
      expect.objectContaining({
        stage: "notify",
        target: "#12",
        cause: "double-claim",
      }),
    ]);
    expect(launches(receipt)).toEqual([]);
  });

  it("reports a session waiting past blocked_after, which keeps its slot", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, true))[0]?.record);
    const path = readRecordFile(id, dispatchState(w))?.workspace?.path ?? "";
    await waitFor("the session", () => claudeRuns(w).length === 1);
    w.setWorkspaces([
      {
        branch: "12-issue-12",
        path,
        agents: [
          {
            state: "blocked",
            paneKey: "tab-1:leaf-1",
            since: Date.now() - 3_600_000,
          },
        ],
      },
    ]);
    const receipt = await applyTick(w, true);
    expect(receipt.repos[0]?.actions).toContainEqual(
      expect.objectContaining({ target: "#12", cause: "waiting" }),
    );
    expect(receipt.repos[0]?.running.map((r) => r.target)).toEqual(["#12"]);
  });

  it("with Orca's own answer, reports the pickup with the reason and starts nothing", async () => {
    const w = fixture();
    const [reported] = launches(await applyTick(w, false));
    expect(reported).toMatchObject({ action: "pickup", outcome: "reported" });
    expect(String(reported?.detail)).toContain(
      "cannot bind its session to a chosen account",
    );
    expect(orcaCalls(w, "worktree", "create")).toEqual([]);
    expect(orcaCalls(w, "terminal", "create")).toEqual([]);
    expect(recordIds(w)).toEqual([]);
  });
});

describe("jig dispatch result", () => {
  it("records a session's answer once, under its own record's token only", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, true))[0]?.record);
    const token = readRecordFile(id, dispatchState(w))?.token ?? "";

    const foreign = await w.dispatch(["result", id, "not-its-token", "done"]);
    expectSpawnExit(foreign, 2);
    expect(foreign.stderr).toContain("is not a launch record with that token");

    const first = await w.dispatch(["result", id, token, "done"]);
    expectSpawnExit(first, 0);
    const second = await w.dispatch(["result", id, token, "failed"]);
    expectSpawnExit(second, 3);
    expect(second.stderr).toContain("already has a result (done)");
    expect(existsSync(join(dispatchState(w), "launches", `${id}.result`))).toBe(
      true,
    );

    writeFileSync(join(w.dir, "claude-exit"), "");
    await waitFor("the exit", () => exitWritten(w, id));
  });
});
