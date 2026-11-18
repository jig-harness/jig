/** A merged pull request and runtime account for follow-up launch tests. */
import { expect } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { MARKER } from "../lib/followup-marker.ts";
import { readRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World } from "./fixtures.ts";
import {
  account,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

export const FOLLOWUP_CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

export function followupWorkspace(
  w: World,
  limits: Record<string, string> = {},
): void {
  w.setConfig(FOLLOWUP_CONFIG);
  withOrigin(w);
  const branch = "feature/9-done";
  w.setPrs("merged", [mergedPr(9, branch, "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const path = join(w.root, "ws-9");
  mkdirSync(path, { recursive: true });
  w.setWorkspaces([{ branch, linkedPR: 9, path }]);
  machineFile(
    w,
    [account(w, "a", "a@example.com")],
    limits,
    ["followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
}

type Comment = { id: number; body: string };
export const markers = (w: World): Comment[] =>
  (
    JSON.parse(
      readFileSync(join(w.dir, "comments-9.json"), "utf8"),
    ) as Comment[]
  ).filter((c) => c.body.startsWith(MARKER));
export const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
export const notices = (r: TickReceipt) =>
  (r.repos[0]?.actions ?? []).filter((a) => a.stage === "notify");

/** Launch the follow-up and let its pass record `waits` with `args`, then exit; its launch record. */
export async function passWaits(w: World, args: string[]): Promise<string> {
  const runs = claudeRuns(w).length;
  const [launched] = launches(await applyTick(w, false));
  expect(launched).toMatchObject({ action: "followup", outcome: "launched" });
  const id = String(launched?.record);
  await waitFor("the pass", () => claudeRuns(w).length === runs + 1);
  const record = readRecord(id, dispatchState(w));
  expect(record?.facts.startsWith("recovery: ")).toBe(false);
  expectSpawnExit(
    await w.dispatch(["result", id, String(record?.token), "waits", ...args]),
    0,
  );
  writeFileSync(join(w.dir, "claude-exit"), "0");
  await waitFor("the exit", () => exitWritten(w, id));
  rmSync(join(w.dir, "claude-exit"));
  return id;
}

/** The tick after a wait's time: it starts nothing, deletes the marker, asks no person, and says why it still holds. */
export async function released(w: World, reason: string): Promise<void> {
  const r = await applyTick(w, false);
  expect(launches(r)).toEqual([]);
  expect(notices(r)).toEqual([]);
  expect(r.repos[0]?.running).toContainEqual(
    expect.objectContaining({
      target: "PR #9",
      stage: "followup",
      reason: expect.stringContaining(reason),
    }),
  );
  expect(markers(w)).toEqual([]);
}
