/**
 * A follow-up whose pass met a rate limit records `waits` with the reset:
 * the tick holds it until then with no question for a person, releases its
 * marker once the reset has passed, and starts it again as a first run. The
 * third wait in a row is a person's, the rate limit named in the notice.
 */
import { afterEach, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { MARKER } from "../lib/followup-marker.ts";
import { readRecord } from "../lib/launches.ts";
import { followupPassArgv } from "../lib/session.ts";
import { stateDb } from "../lib/state.ts";
import { resultMain } from "../result.ts";
import type { TickReceipt } from "../receipts.ts";
import type { World } from "./fixtures.ts";
import { world } from "./fixtures.ts";
import { followupWorkspace } from "./followup-fixtures.ts";
import {
  dispatchState,
  earlierRecord,
  exitWritten,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

function fixture(): World {
  const w = world();
  current = w;
  followupWorkspace(w);
  return w;
}

type Comment = { id: number; body: string };
const markers = (w: World): Comment[] =>
  (
    JSON.parse(
      readFileSync(join(w.dir, "comments-9.json"), "utf8"),
    ) as Comment[]
  ).filter((c) => c.body.startsWith(MARKER));
const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const notices = (r: TickReceipt) =>
  (r.repos[0]?.actions ?? []).filter((a) => a.stage === "notify");

/** Launch the follow-up and let its pass record `waits` until `until`, then exit; its launch record. */
async function waits(w: World, until: string): Promise<string> {
  const runs = claudeRuns(w).length;
  const [launched] = launches(await applyTick(w, false));
  expect(launched).toMatchObject({ action: "followup", outcome: "launched" });
  const id = String(launched?.record);
  await waitFor("the pass", () => claudeRuns(w).length === runs + 1);
  const record = readRecord(id, dispatchState(w));
  expect(record?.facts.startsWith("recovery: ")).toBe(false);
  expectSpawnExit(
    await w.dispatch([
      "result",
      id,
      String(record?.token),
      "waits",
      "--until",
      until,
    ]),
    0,
  );
  writeFileSync(join(w.dir, "claude-exit"), "0");
  await waitFor("the exit", () => exitWritten(w, id));
  rmSync(join(w.dir, "claude-exit"));
  return id;
}

/** Move a wait's reset into the past, as if the time it named had come. */
function resetPassed(w: World, id: string): void {
  stateDb(dispatchState(w))
    .query("UPDATE launches SET result_until = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), id);
}

/** The tick after a wait's reset: it starts nothing, deletes the marker, and asks no person. */
async function released(w: World, id: string): Promise<void> {
  const r = await applyTick(w, false);
  expect(launches(r)).toEqual([]);
  expect(notices(r)).toEqual([]);
  expect(r.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(
        `launch record ${id}'s pass met a rate limit`,
      ),
    }),
  );
  expect(markers(w)).toEqual([]);
}

it("holds a follow-up that waits on a rate limit until the reset, releases its marker after it, and starts it again as a first run", async () => {
  const w = fixture();
  const until = new Date(Date.now() + 3_600_000).toISOString();
  const first = await waits(w, until);
  // The wrapper did not answer the marker: another host reads no failure.
  expect(markers(w)).toHaveLength(1);
  expect(markers(w)[0]?.body).not.toContain("outcome: failed");

  const before = await applyTick(w, false);
  expect(launches(before)).toEqual([]);
  expect(notices(before)).toEqual([]);
  expect(before.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(`waits until ${until}`),
    }),
  );
  expect(markers(w)).toHaveLength(1);
  expect(markers(w)[0]?.body).not.toContain("outcome: failed");

  resetPassed(w, first);
  await released(w, first);

  const runs = claudeRuns(w).length;
  const [again] = launches(await applyTick(w, false));
  expect(again).toMatchObject({ action: "followup", outcome: "launched" });
  await waitFor("the run after the reset", () => claudeRuns(w).length > runs);
  const record = readRecord(String(again?.record), dispatchState(w));
  expect(record?.facts.startsWith("recovery: ")).toBe(false);
  expect(markers(w)).toHaveLength(1);
}, 240_000);

it("hands a follow-up that waited three times in a row to a person, naming the rate limit", async () => {
  const w = fixture();
  const past = () => new Date(Date.now() - 1000).toISOString();
  await released(w, await waits(w, past()));
  await released(w, await waits(w, past()));
  const third = await waits(w, past());

  const after = await applyTick(w, false);
  expect(launches(after)).toEqual([]);
  expect(notices(after)).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      cause: "followup-failed",
      reason: expect.stringContaining(
        `its pass under launch record ${third} met the rate limit 3 times in a row`,
      ),
    }),
  );
  expect(markers(w)).toHaveLength(1);
  expect(claudeRuns(w)).toHaveLength(3);
}, 360_000);

it("takes a waits result on a follow-up's record", () => {
  const w = world();
  current = w;
  const id = "20261110T110200Z-aaaaaaaa";
  earlierRecord(w, { id, account: "a", action: "followup", pr: 9 });
  const until = new Date(Date.now() + 10 * 60_000).toISOString();
  expect(
    resultMain(
      [id, "earlier-token", "waits", "--until", until],
      dispatchState(w),
    ),
  ).toBe(0);
  expect(
    stateDb(dispatchState(w))
      .query("SELECT result, result_until FROM launches WHERE id = ?")
      .get(id),
  ).toEqual({ result: "failed", result_until: until });
});

it("tells a follow-up's pass that a rate limit is a wait, not a question", () => {
  const w = world();
  current = w;
  const record = earlierRecord(w, {
    id: "20261110T110300Z-bbbbbbbb",
    account: "a",
    action: "followup",
    pr: 9,
    command: "/followup",
    marker: 901,
  });
  const prompt = followupPassArgv(record, []).at(-1) ?? "";
  expect(prompt).toContain(
    `dispatch result ${record.id} earlier-token waits --until <that time>`,
  );
  expect(prompt).toContain("API rate limit exceeded");
  expect(prompt).toContain("ask no question");
});
