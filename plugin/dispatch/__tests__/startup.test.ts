import { afterEach, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readRecord } from "../lib/launches.ts";
import { MARKER } from "../lib/followup-marker.ts";
import { wallOf } from "../lib/walls.ts";
import { existingStateDb } from "../lib/state.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture() {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n`,
  );
  w.setPrs("merged", [mergedPr(9, "feature/done", "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: "feature/done", linkedPR: 9, path: ws }]);
  machineFile(
    w,
    [account(w, "a", "a@example.com"), account(w, "b", "b@example.com")],
    {},
    ["followup"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  return w;
}

it.each([false, true])(
  "backs off an unstarted follow-up and retries on another account (quota evidence: %s)",
  async (quota) => {
    const w = fixture();
    const first = await applyTick(w, false);
    const launch = first.repos[0]?.launches?.[0];
    expect(launch?.account).toBe("a");
    const id = String(launch?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    if (quota)
      writeFileSync(
        join(w.dir, "claude-said"),
        "You've hit your limit · resets 5pm (UTC)\n",
      );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    rmSync(join(w.dir, "claude-exit"));
    expect(wallOf("a", Date.now(), dispatchState(w))).not.toBeNull();
    const retry = await applyTick(w, false);
    const row = existingStateDb(dispatchState(w))
      ?.query(
        "SELECT bucket AS class, reason FROM log WHERE json_extract(row, '$.record') = ?",
      )
      .get(id) as { class: string; reason: string };
    expect(row.class).toBe(quota ? "quota wall" : "refused");
    expect(row.reason).toContain("could not start");
    const next = retry.repos[0]?.launches?.some((l) => l.outcome === "launched")
      ? retry
      : await applyTick(w, false);
    expect(next.repos[0]?.launches).toContainEqual(
      expect.objectContaining({
        action: "followup",
        account: "b",
        outcome: "launched",
      }),
    );
  },
);

it("retries the exact startup marker release after the wrapper's forge refusal", async () => {
  const w = fixture();
  writeFileSync(join(w.dir, "comment-delete-fail"), "");
  const first = await applyTick(w, false);
  const id = String(first.repos[0]?.launches?.[0]?.record);
  await waitFor("the pass", () => claudeRuns(w).length === 1);
  const record = readRecord(id, dispatchState(w));
  if (record === null || record.marker === null)
    throw new Error(`no follow-up launch record ${id}`);
  writeFileSync(join(w.dir, "claude-exit"), "1");
  await waitFor("wrapper's refused marker deletion", () =>
    existsSync(join(w.dir, "comment-delete-refused")),
  );
  expect(readFileSync(join(w.dir, "comment-delete-refused"), "utf8")).toBe(
    String(record.marker),
  );
  await waitFor("the exit", () => exitWritten(w, id));
  rmSync(join(w.dir, "claude-exit"));
  const held = await applyTick(w, false);
  expect(held.repos[0]?.launches ?? []).toEqual([]);
  expect(held.repos[0]?.unplaced).toContainEqual(
    expect.objectContaining({
      reason: expect.stringContaining(
        `the unstarted follow-up's marker ${record.marker} could not be released`,
      ),
    }),
  );
  const markers = () =>
    (
      JSON.parse(
        readFileSync(join(w.dir, "comments-9.json"), "utf8"),
      ) as Array<{ id: number; body: string }>
    ).filter((c) => c.body.startsWith(MARKER));
  expect(markers().map((m) => m.id)).toEqual([record.marker]);
  rmSync(join(w.dir, "comment-delete-fail"));
  await applyTick(w, false);
  expect(markers()).toEqual([]);
  const retry = await applyTick(w, false);
  expect(retry.repos[0]?.launches).toContainEqual(
    expect.objectContaining({
      action: "followup",
      account: "b",
      outcome: "launched",
    }),
  );
});

it.each(["transcript", "unreadable scan", "truncated scan"])(
  "keeps died with %s before exiting 1",
  async (mode) => {
    const w = fixture();
    const first = await applyTick(w, false);
    const id = String(first.repos[0]?.launches?.[0]?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    const record = readRecord(id, dispatchState(w));
    if (record === null) throw new Error(`no launch record ${id}`);
    if (mode === "transcript") {
      const dir = join(record.configDir, "projects", "worktree");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${record.sessionId}.jsonl`),
        `${JSON.stringify({ sessionId: record.sessionId, type: "user" })}\n`,
      );
    } else if (mode === "unreadable scan") {
      // A path that exists but cannot be enumerated as a directory is not absence.
      writeFileSync(join(record.configDir, "projects"), "not a directory");
    } else {
      // More entries than the scanner's cap: a stopped visitor is not a complete scan.
      const dir = join(record.configDir, "projects", "worktree");
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < 10_001; i++)
        writeFileSync(join(dir, `${i}.jsonl`), "");
    }
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the exit", () => exitWritten(w, id));
    await applyTick(w, false);
    const row = existingStateDb(dispatchState(w))
      ?.query(
        "SELECT bucket AS class FROM log WHERE json_extract(row, '$.record') = ?",
      )
      .get(id) as { class: string };
    expect(row.class).toBe("died");
    expect(wallOf("a", Date.now(), dispatchState(w))).toBeNull();
  },
);
