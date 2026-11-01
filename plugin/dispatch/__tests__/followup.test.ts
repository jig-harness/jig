/**
 * dispatch --apply: follow-ups. A merged pull request gets one follow-up
 * marker and one session running the repository's follow-up command, once,
 * where the runtime binds an interactive session to its account
 * (`bound-tick.ts` fakes Orca's answer true); with Orca's real answer, the
 * follow-up is reported and nothing is posted or started. A marker is a
 * claim: a manual run's holds the follow-up until it is marked done, and a
 * tick's whose record and outcome are gone is a failed follow-up.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { manualMarker, MARKER, tickMarker } from "../lib/followup-marker.ts";
import { readRecordFile } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  machineFile,
  recordIds,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, orcaCalls } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
`;

const HEAD = "feature/9-done";

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** PR #9 merged, with its workspace; one account, `followup` enabled from before the merge. */
function fixture(): { w: World; ws: string } {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("merged", [mergedPr(9, HEAD, "2026-10-31T12:00:00Z")]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 9, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["followup"], {
    followup_since: "2026-10-30T00:00:00Z",
  });
  return { w, ws };
}

/** A report-only tick, from the machine file's repository and follow-up window. */
async function report(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

type Comment = { id: number; body: string; user: { login: string } };

function comments(w: World): Comment[] {
  return JSON.parse(readFileSync(join(w.dir, "comments-9.json"), "utf8"));
}

const markers = (w: World) =>
  comments(w).filter((c) => c.body.startsWith(MARKER));

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const quiet = (r: TickReceipt) => r.repos[0]?.quiet ?? [];

describe("jig dispatch --apply follows up a merge", () => {
  it("gives a merged pull request exactly one follow-up session across three ticks", async () => {
    const { w, ws } = fixture();

    const first = await applyTick(w, true);
    expect(launches(first)).toEqual([
      expect.objectContaining({
        action: "followup",
        target: "PR #9",
        outcome: "launched",
        account: "a",
      }),
    ]);
    const id = String(launches(first)[0]?.record);
    const record = readRecordFile(id, dispatchState(w));
    expect(record?.action).toBe("followup");
    expect(record?.pr).toBe(9);
    expect(record?.workspace?.path).toBe(ws);
    const [marker] = markers(w);
    expect(marker?.body).toBe(tickMarker(id));
    expect(record?.marker).toBe(marker?.id ?? -1);

    await waitFor("the session", () => claudeRuns(w).length === 1);
    const prompt = claudeRuns(w)[0]?.argv.at(-1) ?? "";
    expect(prompt.startsWith("/followup 9\n")).toBe(true);
    expect(prompt).toContain(`marker check 9 --comment ${marker?.id}`);
    expect(prompt).toContain(`dispatch result ${id} ${record?.token} done`);

    // The session is starting: its wrapper runs, Orca does not report its agent yet.
    const second = await applyTick(w, true);
    expect(launches(second)).toEqual([]);
    expect(second.repos[0]?.running.map((r) => r.target)).toEqual(["PR #9"]);

    // Orca reports the agent working in the pull request's workspace.
    w.setWorkspaces([
      {
        branch: HEAD,
        linkedPR: 9,
        path: ws,
        agents: [{ state: "working", paneKey: "tab-1:leaf-1" }],
      },
    ]);
    const third = await applyTick(w, true);
    expect(launches(third)).toEqual([]);
    expect(third.repos[0]?.running.map((r) => r.target)).toEqual(["PR #9"]);

    expect(markers(w)).toHaveLength(1);
    expect(orcaCalls(w, "terminal", "create")).toHaveLength(1);
    expect(claudeRuns(w)).toHaveLength(1);
    expect(recordIds(w)).toEqual([id]);

    // The session records done and its agent finishes: the follow-up is done, for good.
    expectSpawnExit(
      await w.dispatch(["result", id, String(record?.token), "done"]),
      0,
    );
    w.setWorkspaces([
      {
        branch: HEAD,
        linkedPR: 9,
        path: ws,
        agents: [{ state: "done", paneKey: "tab-1:leaf-1" }],
      },
    ]);
    const fourth = await applyTick(w, true);
    expect(launches(fourth)).toEqual([]);
    expect(quiet(fourth)).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-done" }),
    );
    expect(
      existsSync(
        join(
          dispatchState(w),
          "followups",
          `${SLUG.replace("/", "__")}-9.json`,
        ),
      ),
    ).toBe(true);
  });

  it("reports the follow-up and posts no marker where Orca cannot bind the session", async () => {
    const { w } = fixture();
    const r = await w.dispatch(["--apply", "--json"]);
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(launches(receipt)).toEqual([
      expect.objectContaining({
        action: "followup",
        target: "PR #9",
        outcome: "reported",
      }),
    ]);
    expect(markers(w)).toEqual([]);
    expect(orcaCalls(w, "terminal", "create")).toEqual([]);
  });

  it("holds a follow-up a person's run claimed until that run marks it done", async () => {
    const { w } = fixture();
    w.setComments(9, [forgeComment(901, manualMarker(false))]);
    const held = await report(w);
    expect(held.repos[0]?.actions).toEqual([]);
    expect(quiet(held)).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-held" }),
    );

    const done = await w.dispatch([
      "marker",
      "done",
      "9",
      "--comment",
      "901",
      "--repo",
      SLUG,
    ]);
    expectSpawnExit(done, 0);
    expect(markers(w)[0]?.body).toBe(manualMarker(true));
    expect(quiet(await report(w))).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-done" }),
    );
  });

  it("reads a marker whose comment was saved with CRLF line endings", async () => {
    const { w } = fixture();
    w.setComments(9, [
      forgeComment(905, manualMarker(false).replace(/\n/g, "\r\n")),
    ]);
    const held = await report(w);
    expect(held.repos[0]?.actions).toEqual([]);
    expect(quiet(held)).toContainEqual(
      expect.objectContaining({ target: "PR #9", class: "followup-held" }),
    );
  });

  it("notifies a failed follow-up when the tick's marker names a record this machine no longer has", async () => {
    const { w } = fixture();
    w.setComments(9, [
      forgeComment(902, tickMarker("20261030T200000Z-aaaaaaaa"), "drive-bot"),
    ]);
    const r = await report(w);
    expect(r.repos[0]?.actions).toEqual([
      expect.objectContaining({
        stage: "notify",
        target: "PR #9",
        cause: "followup-failed",
      }),
    ]);
  });

  it("ignores a marker from someone who cannot write, and names it", async () => {
    const { w } = fixture();
    w.setComments(9, [
      forgeComment(903, manualMarker(true), "passer-by", "NONE"),
    ]);
    const [action] = (await report(w)).repos[0]?.actions ?? [];
    expect(action?.stage).toBe("followup");
    expect(String(action?.evidence.ignoredMarkers)).toContain(
      "903 by passer-by",
    );
  });

  it("stands a manual claim down behind an earlier marker, deleting its own", async () => {
    const { w } = fixture();
    w.setComments(9, [forgeComment(904, manualMarker(false))]);
    const r = await w.dispatch(["marker", "claim", "9", "--repo", SLUG]);
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain("comment 904");
    expect(markers(w).map((m) => m.id)).toEqual([904]);
  });

  it("claims a follow-up with a manual marker and checks the claim before each act", async () => {
    const { w } = fixture();
    const claimed = await w.dispatch(["marker", "claim", "9", "--repo", SLUG]);
    expectSpawnExit(claimed, 0);
    const { comment } = JSON.parse(claimed.stdout) as { comment: number };
    expect(markers(w).map((m) => m.body)).toEqual([manualMarker(false)]);
    const check = [
      "marker",
      "check",
      "9",
      "--comment",
      String(comment),
      "--repo",
      SLUG,
    ];
    expectSpawnExit(await w.dispatch(check), 0);
    // A marker that a lagging read hid, earlier than this one, stops the run.
    w.setComments(9, [forgeComment(50, manualMarker(false)), ...comments(w)]);
    expectSpawnExit(await w.dispatch(check), 3);
  });
});
