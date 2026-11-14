/**
 * dispatch --apply: a follow-up whose `jig dispatch result` the host's state
 * database refused (a schema newer than this plugin reads) keeps the evidence
 * of its attempt outside the database, and is run again once, only after the
 * host's health check passes; while it fails, the follow-up is held with no
 * failed follow-up notified. A run again whose write is refused again is a
 * person's, without the question its pass asked about the database.
 */
import { afterEach, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { MARKER } from "../lib/followup-marker.ts";
import { readRecord } from "../lib/launches.ts";
import { Database } from "bun:sqlite";
import { closeStateDb, SCHEMA_VERSION, statePath } from "../lib/state.ts";
import { newRunId, type TickReceipt, writeReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
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

function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n`,
  );
  withOrigin(w);
  w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: "feature/9-done", linkedPR: 9, path: ws }]);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    {},
    ["followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  return w;
}

type Comment = { id: number; body: string };
const markers = (w: World) =>
  (
    JSON.parse(
      readFileSync(join(w.dir, "comments-9.json"), "utf8"),
    ) as Comment[]
  ).filter((c) => c.body.startsWith(MARKER));
const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
/** Whether the evidence of record `id`'s unwritten end was kept. */
const evidenceKept = (w: World, id: string) => {
  const dir = join(dispatchState(w), "unwritten");
  return (
    existsSync(dir) && readdirSync(dir).some((n) => n.startsWith(`${id}.`))
  );
};

const ASKED =
  "Question: should the dispatcher's state database schema be repaired?";

/**
 * Launch the follow-up and let its pass try to record `failed` while the
 * state database is newer than this plugin reads, then stop on a question
 * about it; its launch record, once its exit is written.
 */
async function refused(w: World): Promise<string> {
  const runs = claudeRuns(w).length;
  const [launched] = launches(await applyTick(w, false));
  expect(launched).toMatchObject({ action: "followup", outcome: "launched" });
  const id = String(launched?.record);
  await waitFor("the pass", () => claudeRuns(w).length === runs + 1);
  const root = dispatchState(w);
  const token = String(readRecord(id, root)?.token);
  schemaAt(root, SCHEMA_VERSION + 1);
  const result = await w.dispatch(["result", id, token, "failed"]);
  schemaAt(root, SCHEMA_VERSION);
  expectSpawnExit(result, 4);
  expect(result.stderr).toContain(
    "ask no person about the dispatcher's database or host",
  );
  expect(evidenceKept(w, id)).toBe(true);
  writeFileSync(join(w.dir, "claude-said"), `${ASKED}\n`);
  writeFileSync(join(w.dir, "claude-exit"), "1");
  await waitFor("the exit", () => exitWritten(w, id));
  rmSync(join(w.dir, "claude-exit"));
  rmSync(join(w.dir, "claude-said"));
  return id;
}

/** Set the state database's schema version, as a plugin of that version would leave it. */
function schemaAt(root: string, version: number): void {
  closeStateDb(root);
  const db = new Database(statePath(root));
  db.run(`PRAGMA user_version = ${version}`);
  db.close();
}

/** A tick that exited 1 as the newest receipt: the host's health check fails. */
function failingTick(w: World): void {
  const now = new Date();
  writeReceipt(
    {
      version: 1,
      runId: newRunId(now),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      completed: true,
      apply: true,
      exitStatus: 1,
      repos: [],
    },
    dispatchState(w),
  );
}

it("runs a follow-up whose result write failed again once after the host's health check passes, and hands a second failure to a person", async () => {
  const w = fixture();
  const first = await refused(w);

  failingTick(w);
  const held = await applyTick(w, false);
  expect(launches(held)).toEqual([]);
  expect(held.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      reason: expect.stringContaining(
        "held while the host's health check fails",
      ),
    }),
  );
  expect(held.repos[0]?.actions).not.toContainEqual(
    expect.objectContaining({ stage: "notify", target: "PR #9" }),
  );
  expect(markers(w)).toHaveLength(1);

  const release = await applyTick(w, false);
  expect(launches(release)).toEqual([]);
  expect(release.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      reason: expect.stringContaining(
        `launch record ${first}'s pass could not record its result on this host: the tick releases its marker`,
      ),
    }),
  );
  expect(markers(w)).toEqual([]);

  const second = await refused(w);
  expect(readRecord(second, dispatchState(w))?.facts).toStartWith("recovery: ");

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  const need = after.repos[0]?.actions.find(
    (a) => a.stage === "notify" && a.target === "PR #9",
  );
  expect(need).toMatchObject({
    cause: "followup-failed",
    reason: expect.stringContaining(
      "its result again unwritten on this host after the tick ran it again once",
    ),
  });
  expect(need?.evidence.question).toBeUndefined();
  expect(claudeRuns(w)).toHaveLength(2);
}, 240_000);
