/**
 * dispatch --apply: pickups. An item assigned to the factory identity gets
 * one workspace and one headless `do-item` pass, once, on Orca's own answer
 * that it cannot bind an interactive session: the wrapper binds the pass.
 * The pass keeps the agent's own model, runs under the pickup's deadline,
 * and a pass that stops on a question is notified with it. Stalled pickups
 * and double claims are reported, never launched.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readEnded, readRecord, readResult } from "../lib/launches.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { existingStateDb } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import { readRows } from "../lib/log.ts";
import { updateIdle } from "../lib/idle.ts";
import { assignedIssue, openPr, SLUG, type World, world } from "./fixtures.ts";
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

/** The branch checked out at `path`. */
function branchOf(path: string): string {
  const r = Bun.spawnSync(["git", "-C", path, "branch", "--show-current"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(r, 0);
  return r.stdout.toString().trim();
}

describe("jig dispatch --apply picks up assigned items", () => {
  it("names the item's new workspace and its tab as dispatched, and keeps the mark on its record", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, false))[0]?.record);
    const mark = `⚙ dispatched · pickup #12 · launch ${id}`;
    const [create] = orcaCalls(w, "worktree", "create");
    expect(create?.[create.indexOf("--name") + 1]).toBe(
      "⚙ dispatched · pickup #12",
    );
    expect(create?.[create.indexOf("--comment") + 1]).toBe(mark);
    const record = readRecord(id, dispatchState(w));
    expect(record?.mark).toBe(mark);
    // The branch is still the one the repository's branch rule names.
    expect(branchOf(record?.workspace?.path ?? "")).toBe("12-issue-12");
    const [tab] = orcaCalls(w, "terminal", "create");
    expect(tab?.[tab.indexOf("--title") + 1]).toBe("jig dispatch · pickup #12");
    // The comment the create gave it already carries the mark: the launch writes nothing more.
    expect(orcaCalls(w, "worktree", "set")).toEqual([]);
  });

  it("gives an assigned todo item exactly one headless do-item pass across three ticks, on Orca's own answer", async () => {
    const w = fixture();
    w.env.CLAUDE_CODE_OAUTH_TOKEN = "a-token-for-another-account";

    const first = await applyTick(w, false);
    const [launched] = launches(first);
    expect(launched).toMatchObject({
      action: "pickup",
      target: "#12",
      outcome: "launched",
      account: "a",
      detail: expect.stringContaining(
        "a headless do-item pass bound to account a",
      ),
    });
    const id = String(launched?.record);
    const record = readRecord(id, dispatchState(w));
    expect(record).toMatchObject({
      item: "#12",
      headless: true,
      passTimeoutSec: 3 * 3600,
      codexBypass: false,
      agentId: null,
    });
    const [create] = orcaCalls(w, "worktree", "create");
    expect(create).toContain("--issue");
    expect(create?.[create.indexOf("--issue") + 1]).toBe("12");
    expect(branchOf(record?.workspace?.path ?? "")).toBe("12-issue-12");

    await waitFor("the pass", () => claudeRuns(w).length === 1);
    const [pass] = claudeRuns(w);
    // Bound through the account's directory, with the other account's token gone.
    expect(pass?.configDir).toBe(join(w.root, "config-a"));
    expect(pass?.token).toBeNull();
    const argv = pass?.argv ?? [];
    expect(argv.at(-2)).toBe("-p");
    // The pass keeps the agent's own model and effort.
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--effort");
    const prompt = argv.at(-1) ?? "";
    expect(prompt.startsWith("/jig:do-item #12\nroute: rules\n")).toBe(true);
    expect(prompt).toContain("nobody can answer a question while it runs");
    expect(prompt).toContain(
      'end your output with one line that starts "Question:"',
    );
    expect(prompt).toContain(`dispatch result ${id} ${record?.token} done`);

    // The pass runs: its wrapper holds the item and its slot.
    const second = await applyTick(w, false);
    expect(launches(second)).toEqual([]);
    expect(second.repos[0]?.running.map((r) => r.target)).toEqual(["#12"]);

    // Orca reports the wrapper's terminal working in the item's workspace.
    w.setWorkspaces([
      {
        branch: "12-issue-12",
        path: record?.workspace?.path ?? "",
        agents: [{ state: "working", paneKey: "tab-1:leaf-1" }],
      },
    ]);
    const third = await applyTick(w, false);
    expect(launches(third)).toEqual([]);
    expect(third.repos[0]?.running.map((r) => r.target)).toEqual(["#12"]);

    expect(orcaCalls(w, "worktree", "create")).toHaveLength(1);
    expect(orcaCalls(w, "terminal", "create")).toHaveLength(1);
    expect(claudeRuns(w)).toHaveLength(1);
    expect(recordIds(w)).toEqual([id]);
  });

  it("keeps the route on the record for the implementer, and runs the pass without it", async () => {
    const w = fixture();
    const routed = `${CONFIG}routing: {}\n`;
    w.setConfig(routed);
    // The configuration the route is derived from in the item's workspace.
    const overlay = join(w.root, "routing.yaml");
    writeFileSync(overlay, routed);
    w.env.JIG_OVERLAY = overlay;
    const [launched] = launches(await applyTick(w, false));
    // An item of no known type takes the strictest row: the complex tier.
    expect(String(launched?.detail)).toContain("route complex for Claude Code");
    const id = String(launched?.record);
    expect(readRecord(id, dispatchState(w))).toMatchObject({
      model: "opus",
      effort: "high",
    });
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    const argv = claudeRuns(w)[0]?.argv ?? [];
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("opus");
    expect(argv.at(-1)?.split("\n")[1]).toBe("route: rules");
  });

  it("runs the pass under dispatch.pickup_deadline", async () => {
    const w = fixture();
    w.setConfig(`${CONFIG}  pickup_deadline: 2s\n`);
    writeFileSync(join(w.dir, "claude-stubborn"), "");
    const id = String(launches(await applyTick(w, false))[0]?.record);
    expect(readRecord(id, dispatchState(w))?.passTimeoutSec).toBe(2);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    await waitFor("the exit", () => exitWritten(w, id), 40_000);
    const row = existingStateDb(dispatchState(w))
      ?.query("SELECT exit FROM launches WHERE id = ?")
      .get(id) as { exit: string };
    expect(JSON.parse(row.exit)).toMatchObject({ signal: "SIGKILL" });
  }, 60_000);

  it("notifies a pass that stopped on a question, with the question, as a need, and starts nothing again", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, false))[0]?.record);
    const path = readRecord(id, dispatchState(w))?.workspace?.path ?? "";
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(
      join(w.dir, "claude-said"),
      "The scouts are done.\nQuestion: should the export keep the old column?\n",
    );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));

    const after = await applyTick(w, false);
    expect(launches(after)).toEqual([]);
    const question = "should the export keep the old column?";
    const asked = (after.repos[0]?.actions ?? []).find(
      (a) => a.cause === "pickup-question",
    );
    expect(asked).toMatchObject({
      stage: "notify",
      target: "#12",
      evidence: { record: id, stage: "pickup", question },
      workspace: path,
    });
    expect(asked?.notice?.text).toContain(question);
    const answer = await w.dispatch(["line", "--json"]);
    expectSpawnExit(answer, 0);
    const parsed = JSON.parse(answer.stdout) as {
      value: { line: LineSnapshot };
    };
    expect(parsed.value.line.needs).toContainEqual(
      expect.objectContaining({
        target: "#12",
        cause: "pickup-question",
        stage: "pickup",
      }),
    );
    expect(claudeRuns(w)).toHaveLength(1);
    expect(orcaCalls(w, "terminal", "create")).toHaveLength(1);
  });

  it("notifies the question of a pass that claimed the item before it stopped", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, false))[0]?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(
      join(w.dir, "claude-said"),
      "Question: which of the two schemas is meant?\n",
    );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    // do-item's claim moved the item to in progress.
    w.setIssues([assignedIssue(12, "factory-bot", ["In Progress"])]);
    const after = await applyTick(w, false);
    expect(after.repos[0]?.actions).toContainEqual(
      expect.objectContaining({
        target: "#12",
        cause: "pickup-question",
        reason: expect.stringContaining("which of the two schemas is meant?"),
      }),
    );
    expect(launches(after)).toEqual([]);
  });

  it("records a pickup's opened pull request though the merged listing fails", async () => {
    const w = fixture();
    w.setConfig(`${CONFIG}  followup_command: /followup\n`);
    const id = String(launches(await applyTick(w, false))[0]?.record);
    const path = readRecord(id, dispatchState(w))?.workspace?.path ?? "";
    w.setPrs("open", [
      {
        ...openPr(31, "12-issue-12"),
        createdAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ]);
    w.setWorkspaces([
      {
        branch: "12-issue-12",
        linkedPR: 31,
        path,
        agents: [{ state: "working", paneKey: "tab-1:leaf-1" }],
      },
    ]);
    writeFileSync(join(w.dir, "prs-merged-fail"), "");
    await waitFor("the wrapper", () => claudeRuns(w).length === 1);
    const r = await w.dispatch(["--apply", "--json"]);
    expectSpawnExit(r, 1);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(receipt.repos[0]?.records).toContainEqual(
      expect.objectContaining({ record: "forge", ok: false }),
    );
    expect(readRecord(id, dispatchState(w))?.openedAt).toBeDefined();
  });

  it("says why nothing was started when the rotation cursor cannot be kept", async () => {
    const w = fixture();
    mkdirSync(join(dispatchState(w), "tick-index"), { recursive: true });
    const r = await w.dispatch(["--apply", "--json"]);
    expectSpawnExit(r, 1);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(receipt.apply).toBe(false);
    expect(receipt.applyWithheld).toContain("rotation cursor cannot be kept");
    expect(launches(receipt)).toEqual([]);
    const text = await w.dispatch(["--apply"]);
    expect(text.stdout).toContain("--apply withheld, nothing was started");
  });

  it("does not pick an item up again once its pass ended without claiming it", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, false))[0]?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    const later = await applyTick(w, false);
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
    const [waiting] = launches(await applyTick(w, false));
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
    expect(launches(await applyTick(w, false))[0]).toMatchObject({
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
    const receipt = await applyTick(w, false);
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
    const receipt = await applyTick(w, false);
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
    const receipt = await applyTick(w, false);
    expect(receipt.repos[0]?.actions).toEqual([
      expect.objectContaining({
        stage: "notify",
        target: "#12",
        cause: "double-claim",
      }),
    ]);
    expect(launches(receipt)).toEqual([]);
  });
});

describe("jig dispatch result", () => {
  it("requires a nonempty no-PR reason and rejects contradictory or invalid handoffs", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, false))[0]?.record);
    const token = readRecord(id, dispatchState(w))?.token ?? "";
    for (const args of [
      ["--none", " "],
      ["--pr", "0"],
      ["--pr", "42", "--none", "duplicate"],
    ]) {
      expectSpawnExit(
        await w.dispatch(["result", id, token, "done", ...args]),
        2,
      );
      expect(readResult(id, dispatchState(w))).toBeNull();
    }
    const r = await w.dispatch([
      "result",
      id,
      token,
      "done",
      "--none",
      "duplicate",
    ]);
    expectSpawnExit(r, 0);
    expect(JSON.parse(r.stdout).next).toEqual({ none: "duplicate" });
    writeFileSync(join(w.dir, "claude-exit"), "");
    await waitFor("the exit", () => exitWritten(w, id));
    expect(readEnded(id, dispatchState(w))?.next).toEqual({
      none: "duplicate",
    });
  });
  it("records a session's answer once, under its own record's token only", async () => {
    const w = fixture();
    const id = String(launches(await applyTick(w, false))[0]?.record);
    const token = readRecord(id, dispatchState(w))?.token ?? "";

    const foreign = await w.dispatch(["result", id, "not-its-token", "done"]);
    expectSpawnExit(foreign, 2);
    expect(foreign.stderr).toContain("is not a launch record with that token");

    const missing = await w.dispatch(["result", id, token, "done"]);
    expectSpawnExit(missing, 2);
    expect(missing.stderr).toContain("--pr");
    expect(readResult(id, dispatchState(w))).toBeNull();

    const first = await w.dispatch(["result", id, token, "done", "--pr", "42"]);
    expectSpawnExit(first, 0);
    const second = await w.dispatch(["result", id, token, "failed"]);
    expectSpawnExit(second, 3);
    expect(second.stderr).toContain("already has a result (done)");
    expect(readResult(id, dispatchState(w))).toBe("done");

    writeFileSync(join(w.dir, "claude-exit"), "");
    await waitFor("the exit", () => exitWritten(w, id));
    expect(readEnded(id, dispatchState(w))?.next).toEqual({
      address: `drive@${SLUG}#42`,
    });
    await applyTick(w, false);
    expect(readRows(undefined, undefined, dispatchState(w))).toContainEqual(
      expect.objectContaining({
        kind: "ended",
        record: id,
        next: { address: `drive@${SLUG}#42` },
      }),
    );
  });
});
