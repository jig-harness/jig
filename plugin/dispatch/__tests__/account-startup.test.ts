import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { readRecord } from "../lib/launches.ts";
import { stateDb } from "../lib/state.ts";
import { wallOf } from "../lib/walls.ts";
import {
  assignedIssue,
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture() {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
  followup_command: /followup
`,
  );
  withOrigin(w);
  return w;
}

function readyItem(w: World, n: number): void {
  w.setIssues([assignedIssue(n, "factory-bot", [])]);
  w.setAssigner(n, "maintainer", "WRITE");
}

function transcript(w: World, id: string, message: string): void {
  const record = readRecord(id, dispatchState(w));
  if (record?.sessionId == null) throw new Error(`no session for ${id}`);
  const project = join(record.configDir, "projects", "repo");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    join(project, `${record.sessionId}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: message }] },
    })}\n`,
  );
}

function endRow(w: World, id: string) {
  return stateDb(dispatchState(w))
    .query(
      `SELECT bucket AS class, reason FROM log
     WHERE kind = 'ended' AND json_extract(row, '$.record') = ?`,
    )
    .get(id) as { class: string; reason: string } | null;
}

async function needs(w: World) {
  const result = await w.dispatch(["line", "--json"]);
  expectSpawnExit(result, 0);
  return (JSON.parse(result.stdout) as { value: { line: LineSnapshot } }).value
    .line.needs;
}

test("one sign-in episode releases a pickup, a follow-up and a steward pass", async () => {
  const w = fixture();
  readyItem(w, 12);
  w.setPrs("merged", [mergedPr(9, "feature/done", "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: "feature/done", linkedPR: 9, path: ws }]);
  w.setPrs("open", [openPr(7, "feature/stopped")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 2))]);
  const a = { ...account(w, "a", "a@example.com"), max: 5 };
  const b = { ...account(w, "b", "b@example.com"), max: 5 };
  const stages = ["pickup", "followup", "steward"] as const;
  const settings = { steward: { enabled: true } };
  const repo = { followup_since: "2026-10-30T00:00:00Z" };
  machineFile(w, [a], settings, [...stages], repo);
  const first = (await applyTick(w, false)).repos[0]?.launches ?? [];
  const launched = first.filter((row) => row.outcome === "launched");
  expect(launched.map(({ action }) => action).sort()).toEqual(
    [...stages].sort(),
  );
  expect(launched.every(({ account }) => account === "a")).toBe(true);
  await waitFor("the passes", () => claudeRuns(w).length === 3);
  const ids = launched.map(({ record }) => String(record));
  for (const id of ids)
    transcript(
      w,
      id,
      "Failed to authenticate: OAuth session expired and could not be refreshed",
    );
  writeFileSync(join(w.dir, "claude-exit"), "1");
  await waitFor("the exits", () => ids.every((id) => exitWritten(w, id)));
  rmSync(join(w.dir, "claude-exit"));
  expect(wallOf("a", Date.now(), dispatchState(w))?.source).toContain(
    "sign-in",
  );
  machineFile(w, [a, b], settings, [...stages], repo);
  const launchedAgain =
    (await applyTick(w, false)).repos[0]?.launches.filter(
      (l) => l.outcome === "launched",
    ) ?? [];
  expect(launchedAgain.map(({ action }) => action).sort()).toEqual(
    [...stages].sort(),
  );
  expect(launchedAgain.every(({ account }) => account === "b")).toBe(true);
  for (const id of ids)
    expect(endRow(w, id)).toMatchObject({
      class: "sign-in failure",
      reason: expect.stringContaining("Failed to authenticate"),
    });
  const accountNeeds = (await needs(w)).filter(
    (n) => n.cause === "account-sign-in" || n.cause === "pickup-ended",
  );
  expect(accountNeeds).toMatchObject([
    {
      cause: "account-sign-in",
      target: "account a",
      reason: expect.stringContaining(a.dir),
    },
  ]);
}, 60_000);

test("a successful pass resets the count of consecutive unrecognised startup deaths", async () => {
  const w = fixture();
  const a = account(w, "a", "a@example.com");
  machineFile(w, [a], { startup_failure_threshold: 2 }, ["pickup"]);
  const occurred = [1, 0, 1, 1];
  for (const [index, code] of occurred.entries()) {
    readyItem(w, 12 + index);
    const receipt = await applyTick(w, false);
    const launch = receipt.repos[0]?.launches.find(
      (l) => l.outcome === "launched",
    );
    expect(launch?.account).toBe("a");
    const id = String(launch?.record);
    await waitFor("the pass", () => claudeRuns(w).length === index + 1);
    transcript(w, id, "A vendor failure without a recognised sign-in phrase");
    writeFileSync(join(w.dir, "claude-exit"), String(code));
    await waitFor("the exit", () => exitWritten(w, id));
    rmSync(join(w.dir, "claude-exit"));
    expect(wallOf("a", Date.now(), dispatchState(w))?.source ?? null).toBe(
      index === occurred.length - 1
        ? "session could not start (breaker); wall_backoff"
        : null,
    );
    if (index === 2) expect(endRow(w, id)).toBeNull(); // The next tick logs the exit.
  }
  await applyTick(w, false);
  expect(
    (await needs(w)).filter((n) => n.cause === "account-startup"),
  ).toMatchObject([{ cause: "account-startup", target: "account a" }]);
}, 60_000);
