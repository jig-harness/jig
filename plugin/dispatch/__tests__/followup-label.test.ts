/**
 * dispatch: a follow-up's own state label. Whoever runs the follow-up sets
 * the merged pull request's state label when it ends, through the shared
 * projection, without waiting for a tick: a person's run through
 * `jig dispatch marker done` (`followed-up`) or `marker failed`
 * (`followup-failed`), and a dispatched pass through its wrapper once the
 * pass's exit is recorded.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { forgeComment } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { manualMarker, MARKER, markerRun } from "../lib/followup-marker.ts";
import { mergedPr, SLUG, type World, world } from "./fixtures.ts";
import { readRecord } from "../lib/launches.ts";
import {
  account,
  dispatchState,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  followup_command: /followup
  labels: { enabled: true }
`;

const HEAD = "feature/9-done";
const POST = { pr: 9, writer: { host: "sha256:0123456789abcdef" } };

let current: World | null = null;
afterEach(() => {
  if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

/** PR #9 merged carrying `jig:converged`, with the state labels on on the default branch. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("merged", [
    {
      ...mergedPr(9, HEAD, "2026-10-31T12:00:00Z"),
      labels: [{ name: "jig:converged" }, { name: "area:docs" }],
    },
  ]);
  w.setComments(9, []);
  const ws = join(w.root, "ws-9");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 9, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["followup"], {
    followup_since: "2026-10-30T00:00:00Z",
  });
  return w;
}

/** PR #9's labels as the forge holds them. */
function labels(w: World): string[] {
  const merged = JSON.parse(
    readFileSync(join(w.dir, "prs-merged.json"), "utf8"),
  ) as Array<{ number: number; labels?: Array<{ name: string }> }>;
  return (merged.find((p) => p.number === 9)?.labels ?? [])
    .map((l) => l.name)
    .sort();
}

function markerRuns(w: World) {
  const comments = JSON.parse(
    readFileSync(join(w.dir, "comments-9.json"), "utf8"),
  ) as Array<{ body: string }>;
  return comments
    .filter((c) => c.body.startsWith(MARKER))
    .map((c) => markerRun(c.body, 9));
}

const marker = (verb: string) => [
  "marker",
  verb,
  "9",
  "--comment",
  "901",
  "--repo",
  SLUG,
];

describe("a follow-up labels its own end", () => {
  it("leaves followed-up when a person's run is marked done", async () => {
    const w = fixture();
    w.setComments(9, [forgeComment(901, manualMarker(false, POST))]);
    expectSpawnExit(await w.dispatch(marker("done")), 0);
    expect(labels(w)).toEqual(["area:docs", "jig:followed-up"]);
    expect(markerRuns(w)).toEqual([{ kind: "manual", done: true }]);
  });

  it("leaves followup-failed when a person's run fails, its marker still holding the follow-up", async () => {
    const w = fixture();
    w.setComments(9, [forgeComment(901, manualMarker(false, POST))]);
    expectSpawnExit(await w.dispatch(marker("failed")), 0);
    expect(labels(w)).toEqual(["area:docs", "jig:followup-failed"]);
    expect(markerRuns(w)).toEqual([{ kind: "manual", done: false }]);
  });

  it("reports a refused write and keeps the marker's exit for done, which the marker records", async () => {
    const w = fixture();
    w.setComments(9, [forgeComment(901, manualMarker(false, POST))]);
    writeFileSync(join(w.dir, "label-edit-fail"), "");
    const r = await w.dispatch(marker("done"));
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain("PR #9's state label could not be written");
    expect(markerRuns(w)).toEqual([{ kind: "manual", done: true }]);
  });

  it("fails marker failed when its label, the only record of the failure, is refused", async () => {
    const w = fixture();
    w.setComments(9, [forgeComment(901, manualMarker(false, POST))]);
    writeFileSync(join(w.dir, "label-edit-fail"), "");
    const r = await w.dispatch(marker("failed"));
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain(
      "nothing else records the failed run: no tick sets it for a run a person claimed",
    );
    expect(r.stderr).not.toContain("tick corrects");
  });

  it("says marker failed records nothing where the labels are off", async () => {
    const w = fixture();
    w.setConfig(CONFIG.replace("  labels: { enabled: true }\n", ""));
    w.setComments(9, [forgeComment(901, manualMarker(false, POST))]);
    const r = await w.dispatch(marker("failed"));
    expectSpawnExit(r, 0);
    expect(r.stderr).toContain(
      "dispatch.labels is off on the default branch, so nothing was recorded",
    );
    expect(labels(w)).toEqual(["area:docs", "jig:converged"]);
  });

  it("fails marker failed when the default branch's setting does not read", async () => {
    const w = fixture();
    w.setConfig("dispatch:\n  labels: { enabled: yes-please }\n");
    w.setComments(9, [forgeComment(901, manualMarker(false, POST))]);
    const r = await w.dispatch(marker("failed"));
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("followup-failed label was not written");
  });

  it("leaves followed-up when a dispatched pass records done, before the next tick", async () => {
    const w = fixture();
    const [launched] = (await applyTick(w, false)).repos[0]?.launches ?? [];
    const id = String(launched?.record);
    const token = readRecord(id, dispatchState(w))?.token ?? "";
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    expectSpawnExit(await w.dispatch(["result", id, token, "done"]), 0);
    writeFileSync(join(w.dir, "claude-exit"), "");
    await waitFor("the label", () => labels(w).includes("jig:followed-up"));
    expect(labels(w)).toEqual(["area:docs", "jig:followed-up"]);
  });

  it("leaves followup-failed when a dispatched pass stops on a question", async () => {
    const w = fixture();
    await applyTick(w, false);
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    writeFileSync(
      join(w.dir, "claude-said"),
      "Question: which version does this merge ship in?\n",
    );
    writeFileSync(join(w.dir, "claude-exit"), "1");
    await waitFor("the label", () => labels(w).includes("jig:followup-failed"));
    expect(labels(w)).toEqual(["area:docs", "jig:followup-failed"]);
  });
});
