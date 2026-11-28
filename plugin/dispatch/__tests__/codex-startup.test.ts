/**
 * dispatch --apply: a Codex follow-up that exits unsuccessfully at once,
 * leaving no rollout under its home, is a session that could not start, as
 * a Claude Code one is: its account is walled for `wall_backoff` and its
 * marker is released, so a later tick starts the follow-up again rather than
 * waiting for the stale-claim release or a person.
 */
import { afterEach, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { existingStateDb } from "../lib/state.ts";
import { MARKER } from "../lib/followup-marker.ts";
import { wallOf } from "../lib/walls.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  codexAccount,
  dispatchState,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];

const markers = (w: World) =>
  (
    JSON.parse(readFileSync(join(w.dir, "comments-9.json"), "utf8")) as Array<{
      body: string;
    }>
  ).filter((c) => c.body.startsWith(MARKER));

function exitOf(w: World, id: string): Record<string, unknown> {
  const row = existingStateDb(dispatchState(w))
    ?.query("SELECT exit FROM launches WHERE id = ?")
    .get(id) as { exit: string } | null | undefined;
  return JSON.parse(String(row?.exit)) as Record<string, unknown>;
}

it("walls a Codex follow-up's account and releases its marker when it stops at once with no rollout", async () => {
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
    [codexAccount(w, "c", "codex-account-c")],
    {},
    ["followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  // The host opts in to Codex's bypass, which every unattended Codex pass needs.
  delete w.env.JIG_USER_LAYER;
  writeFileSync(
    join(w.home, ".jig", "jig.yaml"),
    "drive:\n  codex_bypass: true\n",
  );
  writeFileSync(
    join(w.dir, "codex-said"),
    "session id: 01a1f361-96b7-7832-b2b2-9bff016c5883\nERROR: You've hit your usage limit.\n",
  );
  writeFileSync(join(w.dir, "codex-exit"), "1");

  const [launched] = launches(await applyTick(w, false));
  expect(launched).toMatchObject({
    action: "followup",
    outcome: "launched",
    account: "c",
  });
  const id = String(launched?.record);
  await waitFor("the exit", () => exitWritten(w, id));
  expect(exitOf(w, id)).toMatchObject({ code: 1, startup: "unstarted" });
  expect(wallOf("c", Date.now(), dispatchState(w))).not.toBeNull();

  // The marker is released and no launch is made on the walled account.
  const after = await applyTick(w, false);
  expect(launches(after).filter((l) => l.outcome === "launched")).toEqual([]);
  expect(markers(w)).toEqual([]);
}, 90_000);
