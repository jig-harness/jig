import { afterEach, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  pruneLaunches,
  readLaunches,
  readRecord,
  settledEnds,
} from "../lib/launches.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { failedStartup } from "../lib/session-startup.ts";
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

it.each(["none", "stdout", "stderr", "interleaved"])(
  "backs off an unstarted follow-up and retries on another account (quota evidence: %s)",
  async (stream) => {
    const quota = stream !== "none";
    const w = fixture();
    const first = await applyTick(w, false);
    const launch = first.repos[0]?.launches?.[0];
    expect(launch?.account).toBe("a");
    const id = String(launch?.record);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    if (quota) writeFileSync(join(w.dir, "claude-split"), "");
    if (stream === "interleaved")
      writeFileSync(join(w.dir, "claude-interleave"), "");
    if (stream === "stderr") writeFileSync(join(w.dir, "claude-stderr"), "");
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
  expect(
    held.repos[0]?.actions.some((a) => a.cause === "followup-failed"),
  ).toBe(false);
  const commentsPath = join(w.dir, "comments-9.json");
  const comments = readFileSync(commentsPath, "utf8");
  writeFileSync(commentsPath, "[]");
  const settle = join(w.root, "settle-missing.ts");
  writeFileSync(
    settle,
    `import { readLaunches } from ${JSON.stringify(resolve(import.meta.dir, "../lib/launches.ts"))};
import { settleAtExit } from ${JSON.stringify(resolve(import.meta.dir, "../lib/shared-launches.ts"))};
const r = (await readLaunches()).records.find((r) => r.record.id === ${JSON.stringify(id)});
if (!r) throw new Error("missing launch");
await settleAtExit(r);
`,
  );
  expectSpawnExit(await w.dispatch([], settle), 0);
  writeFileSync(commentsPath, comments);
  const records = await readLaunches(dispatchState(w));
  expect(
    pruneLaunches(
      records.records,
      Date.now() + 32 * 86_400_000,
      30,
      dispatchState(w),
    ),
  ).not.toContain(id);
  const started = Date.now() - 61_000;
  expect(failedStartup(record, 1, started, "", started + 59_000)).toBe(
    "unstarted",
  );
  expect(
    failedStartup(record, 1, started, "", started + 60_001),
  ).toBeUndefined();
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
  expect(
    pruneLaunches(
      (await readLaunches(dispatchState(w))).records,
      Date.now() + 32 * 86_400_000,
      30,
      dispatchState(w),
    ),
  ).toContain(id);
  const retry = await applyTick(w, false);
  expect(retry.repos[0]?.launches).toContainEqual(
    expect.objectContaining({
      action: "followup",
      account: "b",
      outcome: "launched",
    }),
  );
});

it("settles an interrupted startup release from its record when the marker is already gone", async () => {
  const w = fixture();
  writeFileSync(join(w.dir, "comment-delete-lost"), "");
  const first = await applyTick(w, false);
  const id = String(first.repos[0]?.launches?.[0]?.record);
  await waitFor("the pass", () => claudeRuns(w).length === 1);
  writeFileSync(join(w.dir, "claude-exit"), "1");
  await waitFor("the exit", () => exitWritten(w, id));
  await waitFor(
    "the deleted marker",
    () => readFileSync(join(w.dir, "comments-9.json"), "utf8") === "[]",
  );
  rmSync(join(w.dir, "claude-exit"));
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n  labels: { enabled: true, only_labeled: true }\n`,
  );
  await applyTick(w, false);
  expect(settledEnds(dispatchState(w)).has(id)).toBe(false);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n`,
  );
  await applyTick(w, false);
  expect(
    pruneLaunches(
      (await readLaunches(dispatchState(w))).records,
      Date.now() + 32 * 86_400_000,
      30,
      dispatchState(w),
    ),
  ).toContain(id);
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
