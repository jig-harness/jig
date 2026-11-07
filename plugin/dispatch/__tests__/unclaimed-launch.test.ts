/**
 * dispatch --apply: a launch the runtime answered as started whose wrapper
 * never claimed its record is notified to a person as stuck once
 * `unclaimed_after` has passed since that answer, once and then suppressed,
 * and released by `jig dispatch clear`; one whose wrapper claimed it within
 * `unclaimed_after` is never flagged, however old the answer grows.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { captureIdentity } from "../../shared/liveness.ts";
import {
  claimRecord,
  type LaunchRecord,
  readRecord,
  writeRecord,
} from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  machineFile,
  recordIds,
} from "./launch-fixtures.ts";
import {
  applyTick,
  claudeRuns,
  notifyWrites,
  withOrigin,
} from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

const HEAD = "feature/9-done";
const MINUTE = 60_000;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #9 merged, with its workspace; one account, `followup` and `notify` enabled; the runtime answers a launch as started and runs nothing. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  withOrigin(w);
  w.setPrs("merged", [mergedPr(9, HEAD, "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 9, path: ws }]);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    {},
    ["followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  writeFileSync(join(w.dir, "orca-terminal-noop"), "");
  return w;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

/** The follow-up launched and answered as started, its wrapper never run: its record, pending. */
async function startedUnclaimed(w: World): Promise<LaunchRecord> {
  const [first] = launches(await applyTick(w, false));
  expect(first).toMatchObject({ target: "PR #9", outcome: "launched" });
  const record = readRecord(String(first?.record), dispatchState(w));
  if (record === null) throw new Error("no launch record");
  expect(record.attempts.map((a) => a.outcome)).toEqual(["sent"]);
  return record;
}

/** The record as if the runtime's started answer came `minutes` ago. */
function answeredAgo(w: World, record: LaunchRecord, minutes: number): string {
  const at = new Date(Date.now() - minutes * MINUTE).toISOString();
  writeRecord(
    { ...record, attempts: record.attempts.map((a) => ({ ...a, at })) },
    dispatchState(w),
  );
  return at;
}

const stuck = (r: TickReceipt, id: string) =>
  (r.repos[0]?.actions ?? []).filter(
    (a) => a.cause === "needs-person" && a.evidence.record === id,
  );

describe("a launch answered as started that no wrapper claimed", () => {
  it("is notified as needing a person once past unclaimed_after, then suppressed, and cleared by jig dispatch clear", async () => {
    const w = fixture();
    const record = await startedUnclaimed(w);

    // Within unclaimed_after its wrapper may still claim it.
    const early = await applyTick(w, false);
    expect(stuck(early, record.id)).toEqual([]);

    const at = answeredAgo(w, record, 20);
    const late = await applyTick(w, false);
    expect(launches(late)).toEqual([]);
    const [action] = stuck(late, record.id);
    const why = String(action?.evidence.stuck);
    expect(why).toContain(`as started at ${at}`);
    expect(why).toContain("no session is joined to its target");
    expect(action).toMatchObject({
      stage: "notify",
      target: "PR #9",
      evidence: { stage: "followup" },
    });
    const notified = (r: TickReceipt) =>
      (r.repos[0]?.notifications ?? []).filter(
        (n) => n.key === action?.notice?.key,
      );
    expect(notified(late).map((n) => n.outcome)).toEqual(["sent"]);
    expect(notifyWrites(w).at(-1)?.join(" ")).toContain(
      `jig dispatch clear ${record.id}`,
    );

    const again = await applyTick(w, false);
    expect(stuck(again, record.id)).toHaveLength(1);
    expect(notified(again).map((n) => n.outcome)).toEqual(["suppressed"]);
    expect(claudeRuns(w)).toEqual([]);
    expect(recordIds(w)).toEqual([record.id]);

    expectSpawnExit(await w.dispatch(["clear", record.id]), 0);
    expect(recordIds(w)).toEqual([]);
  });

  it("is never flagged once its wrapper claimed it within unclaimed_after", async () => {
    const w = fixture();
    const record = await startedUnclaimed(w);
    const at = answeredAgo(w, record, 60);
    const identity = await captureIdentity();
    if (!identity.ok) throw new Error(identity.failure.reason);
    const claimedAt = new Date(Date.parse(at) + 5_000).toISOString();
    expect(
      claimRecord(
        record.id,
        { ...identity.value, claimedAt },
        dispatchState(w),
      ),
    ).toBe(true);

    const next = await applyTick(w, false);
    expect(stuck(next, record.id)).toEqual([]);
    expect(
      (next.repos[0]?.notifications ?? []).filter((n) =>
        n.key.includes(record.id),
      ),
    ).toEqual([]);
    expect(launches(next)).toEqual([]);
  });
});
