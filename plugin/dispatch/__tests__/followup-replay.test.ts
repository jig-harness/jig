/**
 * dispatch --apply: a follow-up whose marker was posted but whose launch
 * never ran, because the tick stopped before the runtime answered, is
 * launched again by the next tick under the same launch record, token and
 * marker while a fresh read proves that safe; one it cannot prove safe is
 * notified to a person as stuck, never launched again, and released only by
 * `jig dispatch clear`.
 */
import { FOLLOWUP_CONFIG, followupWorkspace } from "./followup-fixtures.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { manualMarker, MARKER } from "../lib/followup-marker.ts";
import { type LaunchRecord, readRecord, writeRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import { SLUG, type World, world } from "./fixtures.ts";
import {
  dispatchState,
  exitWritten,
  recordIds,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, notifyWrites } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** PR #9 merged, with its workspace; one account, `followup` and `notify` enabled, a launch's answer awaited 2s. */
function fixture(): World {
  const w = world();
  current = w;
  followupWorkspace(w, { runtime_timeout: "2s" });
  return w;
}

type Comment = { id: number; body: string; user: { login: string } };

const markers = (w: World): Comment[] =>
  (
    JSON.parse(
      readFileSync(join(w.dir, "comments-9.json"), "utf8"),
    ) as Comment[]
  ).filter((c) => c.body.startsWith(MARKER));

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

/**
 * A tick that posted the follow-up's marker and stopped while the runtime
 * had not answered its launch: the record as the tick wrote it just before
 * calling `launch`, pending with its marker and no attempt.
 */
async function stoppedBeforeTheAnswer(w: World): Promise<LaunchRecord> {
  writeFileSync(join(w.dir, "orca-terminal-hang"), "");
  const [first] = launches(await applyTick(w, false));
  expect(first).toMatchObject({ target: "PR #9", outcome: "lost" });
  rmSync(join(w.dir, "orca-terminal-hang"));
  const record = readRecord(String(first?.record), dispatchState(w));
  if (record === null) throw new Error("no launch record");
  expect(record.marker).toBe(markers(w)[0]?.id ?? -1);
  const unanswered = { ...record, attempts: [] };
  writeRecord(unanswered, dispatchState(w));
  return unanswered;
}

describe("a follow-up whose launch never ran after its marker was posted", () => {
  it("is launched again at the next tick under its own record, token and marker", async () => {
    const w = fixture();
    const record = await stoppedBeforeTheAnswer(w);
    const marker = markers(w)[0]?.id;

    const next = await applyTick(w, false);
    expect(launches(next)).toEqual([
      expect.objectContaining({
        target: "PR #9",
        action: "followup",
        outcome: "retried",
        record: record.id,
      }),
    ]);
    expect(recordIds(w)).toEqual([record.id]);
    expect(markers(w).map((m) => m.id)).toEqual([marker ?? -1]);
    expect(readRecord(record.id, dispatchState(w))?.attempts).toEqual([
      expect.objectContaining({ outcome: "sent" }),
    ]);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    const prompt = claudeRuns(w)[0]?.argv.at(-1) ?? "";
    expect(prompt).toContain(`marker check 9 --comment ${marker}`);
    expect(prompt).toContain(`dispatch result ${record.id} ${record.token}`);
    writeFileSync(join(w.dir, "claude-exit"), "");
    await waitFor("the exit", () => exitWritten(w, record.id));
  });

  it("is notified as needing a person, once, when an earlier marker means the replay cannot be proven safe, and launched by nothing until it is cleared", async () => {
    const w = fixture();
    const record = await stoppedBeforeTheAnswer(w);
    // A person's run claimed the follow-up first: its marker is the earlier comment.
    const POST = { pr: 9, writer: { host: "sha256:0123456789abcdef" } };
    w.setComments(9, [
      forgeComment(50, manualMarker(false, POST)),
      ...markers(w),
    ]);

    const next = await applyTick(w, false);
    expect(launches(next)).toEqual([
      expect.objectContaining({
        target: "PR #9",
        outcome: "refused",
        record: record.id,
        detail: expect.stringContaining("comment 50"),
      }),
    ]);
    const stuck = (r: TickReceipt) =>
      (r.repos[0]?.actions ?? []).filter(
        (a) => a.cause === "needs-person" && a.evidence.record === record.id,
      );
    expect(stuck(next)).toEqual([
      expect.objectContaining({
        stage: "notify",
        target: "PR #9",
        evidence: expect.objectContaining({ stage: "followup" }),
      }),
    ]);
    const notified = (r: TickReceipt) =>
      (r.repos[0]?.notifications ?? []).filter(
        (n) => n.key === stuck(next)[0]?.notice?.key,
      );
    expect(notified(next).map((n) => n.outcome)).toEqual(["sent"]);
    expect(notifyWrites(w).at(-1)?.join(" ")).toContain(
      `jig dispatch clear ${record.id}`,
    );
    expect(notifyWrites(w).at(-1)?.join(" ")).toContain(
      `https://github.com/${SLUG}/pull/9`,
    );
    expect(readRecord(record.id, dispatchState(w))?.noReplay).toContain(
      "comment 50",
    );

    // The next tick plans the same notice from the record, and it is not sent twice.
    const later = await applyTick(w, false);
    expect(launches(later)).toEqual([]);
    expect(stuck(later)).toHaveLength(1);
    expect(notified(later).map((n) => n.outcome)).toEqual(["suppressed"]);
    expect(claudeRuns(w)).toEqual([]);
    expect(recordIds(w)).toEqual([record.id]);

    expectSpawnExit(await w.dispatch(["clear", record.id]), 0);
    expect(recordIds(w)).toEqual([]);
  });

  it("waits, and is not marked never replayable, while the repository sets no follow-up command", async () => {
    const w = fixture();
    const record = await stoppedBeforeTheAnswer(w);
    w.setConfig(FOLLOWUP_CONFIG.replace("  followup_command: /followup\n", ""));

    const next = await applyTick(w, false);
    expect(launches(next)).toEqual([
      expect.objectContaining({
        target: "PR #9",
        outcome: "waits",
        record: record.id,
        detail: expect.stringContaining("dispatch.followup_command"),
      }),
    ]);
    expect(claudeRuns(w)).toEqual([]);
    expect(
      readRecord(record.id, dispatchState(w))?.noReplay ?? null,
    ).toBeNull();
  });
});
