/**
 * dispatch --apply: what the dispatcher starts is named as the dispatcher's.
 * A workspace it creates for a re-arm or a follow-up carries the dispatched
 * name (the mark, the stage, the key), and its comment the mark with the
 * launch record's id, which the record keeps; one it reuses keeps its name
 * and gets the mark added to its comment once; a terminal tab names the
 * dispatcher. A notification that rewrites the comment keeps the mark, and a
 * mark Orca refuses to write leaves the launch as it was. The pickup's naming
 * is in `pickup.test.ts`, the notices workspace's in `notify.test.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readRecord } from "../lib/launches.ts";
import {
  keepMarks,
  marksIn,
  NOTICES_NAME,
  withMark,
  withoutMarks,
} from "../lib/runtime/port.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  mergedPr,
  openPr,
  type OrcaRow,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  machineFile,
  terminalCreates,
} from "./launch-fixtures.ts";
import { applyTick, orcaCalls, withOrigin } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** A world with origin, one account, and the stages given. */
function base(stages: string[], extra: Record<string, unknown> = {}): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], extra, stages, {
    followup_since: "2026-10-30T00:00:00Z",
  });
  return w;
}

/** PR #7 quota-parked, re-armable; its workspace as `rows` gives it (none when absent). */
function rearmable(
  rows: (ws: string) => OrcaRow[] = () => [],
  extra: Record<string, unknown> = {},
): { w: World; ws: string } {
  const w = base(["rearm", "notify"], extra);
  w.setPrs("open", [openPr(7, "feature/7-parked")]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces(rows(ws));
  return { w, ws };
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

/** Orca's row for the workspace at `path`: its comment and the name it shows. */
function shown(w: World, path: string): { comment: string; name: string } {
  const ps = JSON.parse(readFileSync(join(w.dir, "orca-ps.json"), "utf8")) as {
    worktrees: Array<{ path: string; comment: string; displayName?: string }>;
  };
  const row = ps.worktrees.find((r) => r.path === path);
  return { comment: row?.comment ?? "", name: row?.displayName ?? "" };
}

const argOf = (args: string[] | undefined, flag: string) =>
  args?.[args.indexOf(flag) + 1];

describe("jig dispatch names what it starts", () => {
  it("names a re-arm's new workspace and its tab, and keeps the mark on the record", async () => {
    const { w } = rearmable();
    const [launched] = launches(await tick(w));
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
    const id = String(launched?.record);
    const mark = `⚙ dispatched · rearm #7 · launch ${id}`;
    const [create] = orcaCalls(w, "worktree", "create");
    expect(argOf(create, "--name")).toBe("⚙ dispatched · rearm #7");
    expect(argOf(create, "--comment")).toBe(mark);
    const record = readRecord(id, dispatchState(w));
    expect(record?.mark).toBe(mark);
    const path = record?.workspace?.path ?? "";
    expect(shown(w, path)).toEqual({
      comment: mark,
      name: "⚙ dispatched · rearm #7",
    });
    expect(argOf(terminalCreates(w)[0], "--title")).toBe(
      "jig dispatch · rearm #7",
    );
    expect(orcaCalls(w, "worktree", "set")).toEqual([]);
  });

  it("keeps a reused workspace's name and adds the mark to its comment once", async () => {
    const { w, ws } = rearmable(
      (path) => [
        {
          branch: "feature/7-parked",
          linkedPR: 7,
          path,
          name: "Retry budget",
          comment: "Keep three retries",
        },
      ],
      { runtime_timeout: "2s" },
    );
    // The first launch's answer is lost; the next tick replays it under the same record.
    writeFileSync(join(w.dir, "orca-terminal-hang"), "");
    const [first] = launches(await tick(w));
    expect(first?.outcome).toBe("lost");
    rmSync(join(w.dir, "orca-terminal-hang"));
    const [second] = launches(await tick(w));
    expect(second).toMatchObject({ outcome: "retried", record: first?.record });

    const mark = `⚙ dispatched · rearm #7 · launch ${first?.record}`;
    expect(shown(w, ws)).toEqual({
      comment: `Keep three retries\n${mark}`,
      name: "Retry budget",
    });
    const sets = orcaCalls(w, "worktree", "set");
    expect(sets).toHaveLength(1);
    expect(sets.flat()).not.toContain("--display-name");
    expect(orcaCalls(w, "worktree", "create")).toEqual([]);
    const titles = terminalCreates(w).map((a) => argOf(a, "--title"));
    expect(titles).toEqual([
      "jig dispatch · rearm #7",
      "jig dispatch · rearm #7",
    ]);
  });

  it("launches as before when Orca refuses to write the mark, and says so", async () => {
    const { w, ws } = rearmable((path) => [
      { branch: "feature/7-parked", linkedPR: 7, path },
    ]);
    writeFileSync(join(w.dir, "orca-set-fail"), "");
    const [launched] = launches(await tick(w));
    expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
    expect(launched?.detail).toContain(
      "the workspace's comment does not carry the dispatched mark",
    );
    expect(terminalCreates(w)).toHaveLength(1);
    expect(shown(w, ws).comment).toBe("");
    const record = readRecord(String(launched?.record), dispatchState(w));
    expect(record?.mark).toBe(
      `⚙ dispatched · rearm #7 · launch ${launched?.record}`,
    );
  });

  it("keeps the mark when a notification rewrites the workspace's comment", async () => {
    const mark = "⚙ dispatched · rearm #7 · launch 20261030T200000Z-aaaaaaaa";
    const { w, ws } = rearmable((path) => [
      { branch: "feature/7-parked", linkedPR: 7, path, comment: mark },
    ]);
    // Stopped on an exit only a person settles: notified, never re-armed.
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 7))]);
    const receipt = await tick(w);
    expect(receipt.repos[0]?.notifications).toEqual([
      expect.objectContaining({ target: "PR #7", outcome: "sent" }),
    ]);
    const { comment } = shown(w, ws);
    expect(comment.split("\n")[0]).toBe(mark);
    expect(comment).toContain(`[jig dispatch: ${SLUG} PR #7 stopped 7`);
  });

  it("names a follow-up's new workspace and its tab, and keeps the mark on the record", async () => {
    const w = base(["followup"]);
    w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z")]);
    w.setComments(9, []);
    const [opened] = launches(await applyTick(w, true));
    expect(opened).toMatchObject({ action: "followup", outcome: "launched" });
    const id = String(opened?.record);
    const mark = `⚙ dispatched · followup #9 · launch ${id}`;
    const [create] = orcaCalls(w, "worktree", "create");
    expect(argOf(create, "--name")).toBe("⚙ dispatched · followup #9");
    expect(argOf(create, "--comment")).toBe(mark);
    expect(readRecord(id, dispatchState(w))?.mark).toBe(mark);
    expect(argOf(terminalCreates(w)[0], "--title")).toBe(
      "jig dispatch · followup #9",
    );
  });

  it("adds a follow-up's mark to the comment of the workspace it reuses", async () => {
    const w = base(["followup"]);
    w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z")]);
    w.setComments(9, []);
    const ws = join(w.root, "ws-9");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([
      { branch: "feature/9-done", linkedPR: 9, path: ws, name: "Retries" },
    ]);
    const [launched] = launches(await applyTick(w, true));
    expect(launched).toMatchObject({ action: "followup", outcome: "launched" });
    expect(shown(w, ws)).toEqual({
      comment: `⚙ dispatched · followup #9 · launch ${launched?.record}`,
      name: "Retries",
    });
    expect(orcaCalls(w, "worktree", "create")).toEqual([]);
    expect(argOf(terminalCreates(w)[0], "--title")).toBe(
      "jig dispatch · followup #9",
    );
  });

  it("says so when the workspace's comment did not take the mark", async () => {
    const w = base(["followup"]);
    w.setPrs("merged", [mergedPr(9, "feature/9-done", "2026-10-31T12:00:00Z")]);
    w.setComments(9, []);
    const ws = join(w.root, "ws-9");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([
      { branch: "feature/9-done", linkedPR: 9, path: ws, name: "Retries" },
    ]);
    writeFileSync(join(w.dir, "orca-set-noop"), "");
    const [launched] = launches(await applyTick(w, true));
    const record = readRecord(launched?.record as string, dispatchState(w));
    expect(record?.attempts[0]?.detail).toContain(
      "does not carry the dispatched mark",
    );
    expect(shown(w, ws).comment).not.toContain("dispatched");
  });
});

describe("the dispatched mark in a comment", () => {
  const a = "⚙ dispatched · rearm #7 · launch 20261101T010000Z-aaaaaaaa";
  const b = "⚙ dispatched · rearm #7 · launch 20261101T020000Z-bbbbbbbb";
  const takeover =
    "⚙ dispatched · takeover #7 · launch 20261101T030000Z-cccccccc";

  it("is added once, after what the comment holds", () => {
    expect(withMark("", a)).toBe(a);
    expect(withMark("Keep three retries", a)).toBe(`Keep three retries\n${a}`);
    expect(withMark(`Keep three retries\n${a}`, a)).toBeNull();
  });

  it("of a later launch of the same stage and key replaces the earlier one", () => {
    expect(withMark(`Keep three retries\n${a}\n${takeover}`, b)).toBe(
      `Keep three retries\n${takeover}\n${b}`,
    );
  });

  it("stays, once, when a message rewrites the comment", () => {
    expect(keepMarks(`${a}\nold message`, "new message")).toBe(
      `${a}\n\nnew message`,
    );
    expect(keepMarks(`${a}\nold`, `${a}\n\nnew`)).toBe(`${a}\n\nnew`);
    expect(keepMarks("a person's note", "new")).toBe("new");
  });

  it("is recognized only in the shape of a launch's mark or the notices workspace's", () => {
    expect(
      marksIn(
        [
          "⚙ dispatched · keep the retry investigation notes",
          "⚙ dispatched · unknown #7 · launch 20261101T010000Z-aaaaaaaa",
          "⚙ dispatched · rearm #7 · launch nope",
          a,
        ].join("\n"),
      ).map((m) => m.line),
    ).toEqual([a]);
    expect(withoutMarks("⚙ dispatched · keep the retry notes")).toBe(
      "⚙ dispatched · keep the retry notes",
    );
  });

  it("is the freshly read comment's, not an older launch's that a message carries", () => {
    expect(keepMarks(`${b}\nold`, `${a}\n\nnew message`)).toBe(
      `${b}\n\nnew message`,
    );
  });

  it("names its stage, key and launch, and leaves the rest of the comment", () => {
    expect(marksIn(`note\n${a}\n${NOTICES_NAME}`)).toEqual([
      {
        line: a,
        name: "⚙ dispatched · rearm #7",
        launch: "20261101T010000Z-aaaaaaaa",
      },
      { line: NOTICES_NAME, name: NOTICES_NAME, launch: null },
    ]);
    expect(withoutMarks(`note\n${a}`)).toBe("note");
  });
});
